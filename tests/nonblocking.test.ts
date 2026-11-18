import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { contentText, type Provider, type Usage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type BoundaryResult,
	type BoundaryState,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import {
	createSubagentIntegration,
	type SubagentView,
} from "../agent/index.ts";
import {
	COMMAND_EXIT_TYPE,
	SUBAGENT_REMINDER_TYPE,
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_USAGE_TYPE,
	type SubagentCompletionDetails,
} from "../agent/protocol.ts";
import { spawnContext } from "../agent/sessions.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	backgroundJob,
	charges,
	checkpoint,
	completionOutput,
	customMessages,
	deferred,
	lastCustomMessage,
	lastText,
	model,
	onCleanup,
	parentSession,
	removeOutputOnCleanup,
	replies,
	report,
	response,
	rootSession,
	stillPending,
	stream,
	testProvider,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

const completions = (session: AgentSession) =>
	customMessages(session.messages, SUBAGENT_RESULT_TYPE);

function completionDetails(session: AgentSession): SubagentCompletionDetails {
	const message = completions(session).at(-1);
	if (!message) throw new Error("Missing completion");
	return message.details as SubagentCompletionDetails;
}

const defaultDispatch = stream((context) => {
	const text = lastText(context);
	if (text === "delegate")
		return toolCall("subagent", { instructions: "child task" });
	if (context.messages.at(-1)?.role === "toolResult")
		return response("parent available");
	if (lastCustomMessage(context, SUBAGENT_RESULT_TYPE))
		return response("completion accepted");
	return text === "child task"
		? report("child answer")
		: response("another prompt accepted");
});

test("the tool starts the child with the requested effort and rejects unknown models", async () => {
	const {
		session,
		tree,
		execute: call,
	} = await rootSession({ streamFn: defaultDispatch });
	const execute = (args: { model?: string; effort?: "low" }) =>
		call("configured", { instructions: "child task", ...args });
	await expect(execute({ model: "missing" })).rejects.toThrow(
		'Unknown model "missing"',
	);
	expect(tree.tree()).toHaveLength(0);
	await execute({ model: "test-provider/test-model", effort: "low" });
	await until(() => completions(session).length === 1);
	expect(tree.get("1")?.session?.model).toMatchObject({ id: model.id });
	expect(tree.get("1")?.session?.thinkingLevel).toBe("low");
});

test("nohup completion notifies the parent once, with the child's report", async () => {
	let job: ReturnType<typeof backgroundJob> | undefined;
	const { session, tree } = await rootSession({
		streamFn: stream((context) => {
			const text = lastText(context);
			if (text === "delegate")
				return toolCall("subagent", { instructions: "start job" });
			if (text === "start job") {
				if (!job) throw new Error("Missing job");
				return toolCall("bash", { command: job.command });
			}
			if (lastCustomMessage(context, SUBAGENT_RESULT_TYPE))
				return response("completion accepted");
			// Answering the user is no report; the job's exit leads to one.
			if (lastCustomMessage(context, COMMAND_EXIT_TYPE))
				return report("child report after exit");
			if (text === "final update") return response("last child answer");
			return response("available while job runs");
		}),
	});
	job = backgroundJob(session.sessionManager.getCwd(), "notify");
	await session.prompt("delegate");
	await until(() => tree.get("1")?.session?.isIdle === true);
	expect(tree.get("1")?.status).toBe("running");
	expect(completions(session)).toHaveLength(0);
	await tree.send("1", "final update");
	expect(completions(session)).toHaveLength(0);
	await job.release();
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(existsSync(job.finished)).toBe(true);
	const [completion] = completions(session);
	if (!completion) throw new Error("Missing completion");
	expect(completionOutput(completion)).toBe("child report after exit");
	expect(session.getLastAssistantText()).toBe("completion accepted");
	await tree.settled(ROOT);
	expect(completions(session)).toHaveLength(1);
});

test("root returns a receipt and accepts another prompt while child session initialization is blocked", async () => {
	const initialization = checkpoint();
	const { session, tree } = await rootSession({
		streamFn: defaultDispatch,
		onChildStart: () => initialization.pass(),
	});
	await session.prompt("delegate");
	expect(session.getLastAssistantText()).toBe("parent available");
	const receipt = session.messages.find(
		(message) => message.role === "toolResult",
	);
	if (receipt?.role !== "toolResult") throw new Error("Missing receipt");
	expect(receipt.details).toEqual({
		id: "1",
		status: "running",
	});
	expect(receipt.usage).toBeUndefined();
	expect(completions(session)).toHaveLength(0);
	expect(tree.get("1")?.status).toBe("running");
	await session.prompt("another prompt");
	expect(session.getLastAssistantText()).toBe("another prompt accepted");
	await until(() => initialization.reached);
	initialization.open();
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(completionDetails(session)).toMatchObject({
		id: "1",
		status: "done",
		usage: { totalTokens: 3 },
	});
	expect(session.getLastAssistantText()).toBe("completion accepted");
	expect(session.getSessionStats().tokens.total).toBe(15);
	expect(charges(session)).toHaveLength(1);
});

test.each(["initializing", "running"] as const)(
	"changing the parent model while a child is %s keeps the child independent and delivers its result",
	async (phase) => {
		const child = checkpoint();
		const alternate = {
			...model,
			provider: "alternate-provider",
			id: "alternate-model",
		};
		const requests: { text: string; provider: string; model: string }[] = [];
		const respond = stream(async (context, options) => {
			if (phase === "running" && lastText(context) === "child task")
				await child.pass(options?.signal);
			return defaultDispatch.respond(context, options);
		});
		const dispatch: Provider["streamSimple"] = (selected, context, options) => {
			requests.push({
				text: lastText(context),
				provider: selected.provider,
				model: selected.id,
			});
			return respond(selected, context, options);
		};
		const { session, tree } = await rootSession({
			streamFn: dispatch,
			onChildStart: phase === "initializing" ? () => child.pass() : undefined,
			extensions: [
				(pi) =>
					pi.registerProvider({
						...testProvider(dispatch),
						id: alternate.provider,
						getModels: () => [alternate],
					}),
			],
		});
		await session.prompt("delegate");
		await until(() => child.reached);
		// /model uses setModel; it must not wait for the detached child.
		await session.setModel(alternate);
		expect(session.model).toEqual(alternate);
		expect(tree.get("1")?.status).toBe("running");
		expect(tree.get("1")?.context.model).toEqual(model);
		await session.prompt("another prompt");
		expect(requests.at(-1)).toEqual({
			text: "another prompt",
			provider: alternate.provider,
			model: alternate.id,
		});
		child.open();
		await until(() => completions(session).length === 1 && session.isIdle);
		expect(tree.get("1")?.session?.model).toEqual(model);
		expect(completionDetails(session)).toMatchObject({
			id: "1",
			status: "done",
		});
		expect(session.getLastAssistantText()).toBe("completion accepted");
		expect(requests.at(-1)).toMatchObject({
			provider: alternate.provider,
			model: alternate.id,
		});
	},
);

test.each(["finishes", "is interrupted"] as const)(
	"a result for a busy parent is held until its newer prompt %s",
	async (ending) => {
		const child = checkpoint();
		const parent = checkpoint();
		let completionRequests = 0;
		const dispatch = stream(async (context, options) => {
			const text = lastText(context);
			if (text === "child task") {
				await child.pass(options?.signal);
				return report("child answer");
			}
			if (text === "busy prompt") {
				await parent.pass(options?.signal);
				return response("newer prompt finished");
			}
			if (lastCustomMessage(context, SUBAGENT_RESULT_TYPE)) {
				completionRequests++;
				return response("completion accepted");
			}
			return defaultDispatch.respond(context, options);
		});
		const { session, tree } = await rootSession({ streamFn: dispatch });
		await session.prompt("delegate");
		await until(() => child.reached);
		const busy = session.prompt("busy prompt");
		await until(() => parent.reached);
		child.open();
		await tree.settled(ROOT);
		// Held by the integration, so an interrupt clearing pi's queue cannot drop it.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(completions(session)).toHaveLength(0);
		expect(completionRequests).toBe(0);
		if (ending === "finishes") {
			parent.open();
			await busy;
			await session.waitForIdle();
			// A follow-up to the newer prompt, not an interruption of it.
			expect(replies(session.messages).slice(-2)).toEqual([
				"newer prompt finished",
				"completion accepted",
			]);
		} else {
			// Pi's interactive interrupt clears queued messages before aborting.
			session.clearQueue();
			await session.abort();
			await busy;
			// Kept without restarting the turn.
			expect(session.isIdle).toBe(true);
			expect(completionRequests).toBe(0);
		}
		expect(completions(session)).toHaveLength(1);
	},
);

test("provider errors are delivered after the receipt with usage and a terminal error status", async () => {
	const dispatch = stream((context, options) => {
		if (lastText(context) === "child task")
			throw new Error("provider unavailable");
		return defaultDispatch.respond(context, options);
	});
	const { session, tree } = await rootSession({ streamFn: dispatch });
	await session.prompt("delegate");
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(completionDetails(session)).toMatchObject({
		status: "error",
		error: "provider unavailable",
		usage: { totalTokens: 3 },
	});
	expect(JSON.stringify(completions(session)[0]?.content)).toContain(
		"provider unavailable",
	);
	expect(tree.get("1")?.status).toBe("error");
	expect(session.getSessionStats().tokens.total).toBe(12);
});

test("an already-aborted tool call rejects, but aborting its signal after receipt does not cancel the detached job", async () => {
	const child = checkpoint();
	let aborted = false;
	const dispatch = stream(async (context, options) => {
		if (lastText(context) === "child task") {
			options?.signal?.addEventListener("abort", () => {
				aborted = true;
			});
			await child.pass(options?.signal);
			return response("child answer");
		}
		return defaultDispatch.respond(context, options);
	});
	const { session, tree, execute } = await rootSession({ streamFn: dispatch });
	await expect(
		execute(
			"rejected",
			{ instructions: "child task" },
			AbortSignal.abort(new Error("already cancelled")),
		),
	).rejects.toThrow("already cancelled");
	expect(tree.tree()).toHaveLength(0);
	const controller = new AbortController();
	const receipt = await execute(
		"detached",
		{ instructions: "child task" },
		controller.signal,
	);
	expect(receipt.details).toMatchObject({ id: "1", status: "running" });
	controller.abort();
	await until(() => child.reached);
	expect(tree.get("1")?.cancelled).toBe(false);
	expect(aborted).toBe(false);
	tree.abort("1");
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(aborted).toBe(true);
	expect(completionDetails(session)).toMatchObject({
		status: "aborted",
		usage: { totalTokens: 3 },
	});
});

test("interrupting the originating parent leaves the child running and still delivers its result", async () => {
	const child = checkpoint();
	const dispatch = stream(async (context, options) => {
		const text = lastText(context);
		if (text === "child task") {
			await child.pass(options?.signal);
			return report("late child answer");
		}
		if (context.messages.at(-1)?.role === "toolResult")
			return waiting(options?.signal);
		return defaultDispatch.respond(context, options);
	});
	const { session, tree } = await rootSession({ streamFn: dispatch });
	const prompt = session.prompt("delegate");
	await until(
		() =>
			child.reached &&
			session.messages.some((message) => message.role === "toolResult"),
	);
	// Pi's interactive interrupt clears queued messages before aborting.
	session.clearQueue();
	await session.abort();
	await prompt;
	expect(tree.get("1")?.cancelled).toBe(false);
	await session.prompt("corrected prompt");
	expect(session.getLastAssistantText()).toBe("another prompt accepted");
	child.open();
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(completionDetails(session)).toMatchObject({ id: "1", status: "done" });
	expect(session.getLastAssistantText()).toBe("completion accepted");
	expect(charges(session)).toHaveLength(1);
});

test("a result arriving during an interrupt is kept without restarting the turn", async () => {
	const child = checkpoint();
	const parent = checkpoint();
	const agentEnd = checkpoint();
	let completionRequests = 0;
	let resultInContext = false;
	const dispatch = stream(async (context, options) => {
		const text = lastText(context);
		if (text === "child task") {
			await child.pass(options?.signal);
			return report("child answer");
		}
		if (text === "newer root prompt") await parent.pass(options?.signal);
		if (lastCustomMessage(context, SUBAGENT_RESULT_TYPE)) completionRequests++;
		if (text === "another prompt")
			resultInContext = JSON.stringify(context.messages).includes(
				"child answer",
			);
		return defaultDispatch.respond(context, options);
	});
	const { session, tree } = await rootSession({
		streamFn: dispatch,
		extensions: [
			(pi) => {
				pi.on("agent_end", async (_event, ctx) => {
					if (ctx.signal?.aborted) await agentEnd.pass();
				});
			},
		],
	});
	await session.prompt("delegate");
	await until(() => child.reached);
	const prompt = session.prompt("newer root prompt");
	await until(() => parent.reached);
	session.clearQueue();
	const aborted = session.abort();
	await until(() => agentEnd.reached);
	child.open();
	await until(() => charges(session).length > 0);
	expect(tree.get("1")?.status).toBe("done");
	expect(completions(session)).toHaveLength(0);
	agentEnd.open();
	await aborted;
	await prompt;
	expect(session.isIdle).toBe(true);
	expect(completions(session)).toHaveLength(1);
	expect(completionRequests).toBe(0);
	await session.prompt("another prompt");
	expect(resultInContext).toBe(true);
	expect(session.getLastAssistantText()).toBe("another prompt accepted");
	expect(completionRequests).toBe(0);
});

test("results held by a busy parent are released together, starting one turn", async () => {
	const parent = checkpoint();
	let completionRequests = 0;
	let children = 0;
	const dispatch = stream(async (context, options) => {
		const text = lastText(context);
		if (text === "delegate twice")
			return response("", {
				stopReason: "toolUse",
				content: ["first", "second"].map((instructions) => ({
					type: "toolCall" as const,
					id: crypto.randomUUID(),
					name: "subagent",
					arguments: { instructions },
				})),
			});
		if (text === "first" || text === "second") {
			children++;
			return report(`${text} answer`);
		}
		if (context.messages.at(-1)?.role === "toolResult") {
			await parent.pass(options?.signal);
			return response("parent finished");
		}
		if (lastCustomMessage(context, SUBAGENT_RESULT_TYPE)) {
			completionRequests++;
			return response("completions accepted");
		}
		return defaultDispatch.respond(context, options);
	});
	const { session, tree } = await rootSession({ streamFn: dispatch });
	const prompt = session.prompt("delegate twice");
	await until(
		() =>
			parent.reached &&
			children === 2 &&
			tree.tree().every((node) => node.status === "done"),
	);
	await tree.settled(ROOT);
	expect(completions(session)).toHaveLength(0);
	parent.open();
	await prompt;
	await session.waitForIdle();
	expect(completions(session)).toHaveLength(2);
	expect(completionRequests).toBe(1);
	expect(session.getLastAssistantText()).toBe("completions accepted");
});

test("accounting preserves other extensions' boundary drafts both with and without completion metadata", async () => {
	const child = deferred();
	// Every draft another extension adds at a boundary must be persisted.
	const drafted = { "prior-turn": 0, "prior-settle": 0 };
	const draft =
		(customType: keyof typeof drafted) =>
		(event: BoundaryState): BoundaryResult => {
			drafted[customType]++;
			return {
				entries: [...event.entries, { type: "custom", customType, data: true }],
			};
		};
	const { session } = await rootSession({
		streamFn: defaultDispatch,
		onChildStart: () => child.promise,
		extensions: [
			(pi) => {
				pi.on("turn_end", draft("prior-turn"));
				pi.on("agent_before_settle", draft("prior-settle"));
			},
		],
	});
	const metadata = (kind: string) =>
		session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === kind);
	const expectPersisted = () => {
		for (const [kind, count] of Object.entries(drafted)) {
			expect(count).toBeGreaterThan(0);
			expect(metadata(kind)).toHaveLength(count);
		}
	};
	await session.prompt("delegate");
	expectPersisted();
	expect(metadata(SUBAGENT_USAGE_TYPE)).toHaveLength(0);
	const before = { ...drafted };
	child.resolve();
	await until(() => completions(session).length === 1 && session.isIdle);
	// Delivering the completion crossed new boundaries, which carried both kinds.
	expect(drafted["prior-settle"]).toBeGreaterThan(before["prior-settle"]);
	expectPersisted();
	expect(metadata(SUBAGENT_USAGE_TYPE)).toHaveLength(1);
});

test.each([false, true])(
	"an accepted steering input hook is included in settlement (disposal: %p)",
	async (dispose) => {
		const original = checkpoint();
		const input = checkpoint();
		const dispatch = stream(async (context, options) => {
			if (lastText(context) === "original")
				await original.pass(options?.signal);
			return lastCustomMessage(context, SUBAGENT_REMINDER_TYPE)
				? report("original finished")
				: response(lastText(context));
		});
		const { session, tree } = await rootSession({
			streamFn: dispatch,
			onChildLoad: (pi) => {
				pi.on("input", async (event) => {
					if (event.text === "late input") await input.pass();
				});
			},
		});
		const started = tree.start(
			"root",
			"original",
			spawnContext(
				session.extensionRunner.createToolContext("original", undefined),
			),
		);
		await until(() => original.reached);
		const node = tree.get(started.id);
		if (!node) throw new Error("Missing child");
		const sent = tree.send(started.id, "late input");
		await until(() => input.reached);
		original.open();
		await until(() => Boolean(node.session?.isIdle));
		// The session is idle, but the gated input still belongs to the run.
		expect(await stillPending(started.result)).toBe(true);
		if (!dispose) {
			input.open();
			await sent;
			// Answering the input is no report, so the task is reminded.
			expect(await started.result).toMatchObject({
				status: "done",
				output: "original finished",
				usage: { totalTokens: 9 },
			});
			expect(JSON.stringify(node.session?.messages)).toContain("late input");
			return;
		}
		const closing = tree.dispose();
		expect(await stillPending(closing)).toBe(true);
		input.open();
		await sent;
		expect(await started.result).toMatchObject({
			status: "aborted",
			usage: { totalTokens: 3 },
		});
		await closing;
		expect(node.session?.isStreaming).toBe(false);
		expect(tree.closed).toBe(true);
	},
);

test("headless extension command failures become run errors rather than successful empty results", async () => {
	const { session, tree, execute } = await rootSession({
		streamFn: defaultDispatch,
		onChildLoad: (pi) => {
			pi.registerCommand("fail", {
				description: "Fail deterministically",
				handler: async () => {
					throw new Error("command failed");
				},
			});
		},
	});
	await execute("command", { instructions: "/fail" });
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(completionDetails(session)).toMatchObject({
		status: "error",
		error: "command failed",
	});
	expect(tree.get("1")?.status).toBe("error");
});

test("disposing a parent without session_shutdown suppresses delivery through its stale extension context", async () => {
	const child = deferred();
	const { session, tree } = await rootSession({
		streamFn: defaultDispatch,
		onChildStart: () => child.promise,
	});
	await session.prompt("delegate");
	session.dispose();
	child.resolve();
	await until(() => tree.get("1")?.status === "done");
	await tree.dispose();
	expect(completions(session)).toHaveLength(0);
	expect(charges(session)).toHaveLength(1);
});

test("shutdown preserves billed child usage in the old parent's ledger without triggering a late turn", async () => {
	const child = checkpoint();
	const dispatch = stream(async (context, options) => {
		if (lastText(context) === "child task") await child.pass(options?.signal);
		return defaultDispatch.respond(context, options);
	});
	const { session, tree } = await rootSession({ streamFn: dispatch });
	await session.prompt("delegate");
	await until(() => child.reached);
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	expect(tree.closed).toBe(true);
	expect(completions(session)).toHaveLength(0);
	expect(session.getSessionStats().tokens.total).toBe(9);
	expect(charges(session)).toMatchObject([{ usage: { totalTokens: 3 } }]);
	expect(session.getLastAssistantText()).toBe("parent available");
});

test("session_start replacement without prior shutdown also fences pending results", async () => {
	const child = deferred();
	const { session, tree, runtime } = await rootSession({
		streamFn: defaultDispatch,
		onChildStart: () => child.promise,
	});
	await session.prompt("delegate");
	const replacement = session.extensionRunner.emit({
		type: "session_start",
		reason: "new",
	});
	child.resolve();
	await replacement;
	expect(tree.closed).toBe(true);
	expect(runtime()).not.toBe(tree);
	await session.prompt("another prompt");
	expect(completions(session)).toHaveLength(0);
});

test("reload cancels and fences old results while the reloaded integration can spawn again", async () => {
	const child = deferred();
	const { session, tree, runtime } = await rootSession({
		streamFn: defaultDispatch,
		onChildStart: () => child.promise,
	});
	await session.prompt("delegate");
	const reload = session.reload();
	child.resolve();
	await reload;
	expect(tree.closed).toBe(true);
	expect(completions(session)).toHaveLength(0);
	await session.prompt("delegate");
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(completionDetails(session)).toMatchObject({ id: "1", status: "done" });
	expect(runtime()).not.toBe(tree);
});

test("completion output is bounded with full output saved, and rich usage is billed once outside the receipt", async () => {
	const huge = "日本語 output\n".repeat(10_000);
	const usage: Usage = {
		...response("").usage,
		input: 2,
		output: 3,
		cacheRead: 4,
		cacheWrite: 5,
		totalTokens: 14,
		reasoning: 2,
		cacheWrite1h: 1,
	};
	const dispatch = stream((context, options) => {
		if (lastText(context) === "child task") return report(huge, { usage });
		return defaultDispatch.respond(context, options);
	});
	const { session } = await rootSession({ streamFn: dispatch });
	await session.prompt("delegate");
	await until(() => completions(session).length === 1 && session.isIdle);
	const completion = completions(session)[0];
	const details = completionDetails(session);
	if (!details.fullOutputPath) throw new Error("Missing full output file");
	removeOutputOnCleanup(details.fullOutputPath);
	expect(await readFile(details.fullOutputPath, "utf8")).toBe(huge);
	if (!completion) throw new Error("Missing completion");
	const text = contentText(completion.content);
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
	expect(text).toContain(details.fullOutputPath);
	expect(text).not.toContain("/subagents");
	expect(details.usage).toEqual(usage);
	expect(session.getSessionStats().tokens).toEqual({
		input: 5,
		output: 9,
		cacheRead: 4,
		cacheWrite: 5,
		total: 23,
	});
	expect(session.getSessionStats().cost).toBeCloseTo(0.12);
	expect(charges(session)).toHaveLength(1);
	const accounting = session.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom" && entry.customType === "subagent-usage",
		);
	expect(accounting).toHaveLength(1);
	expect(accounting[0]?.type === "custom" && accounting[0].data).toMatchObject({
		id: "1",
		status: "done",
		usage,
	});
	expect(
		session.messages.find((message) => message.role === "toolResult")?.usage,
	).toBeUndefined();
	// Only undelivered completions are discarded with the session.
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	expect(await readFile(details.fullOutputPath, "utf8")).toBe(huge);
});

test("the view binds only to root sessions and is released before runtime teardown", async () => {
	const calls: string[] = [];
	const bound = new Map<string, Subagents>();
	const view = (label: string): SubagentView => ({
		bind(runtime) {
			bound.set(label, runtime);
			calls.push(`${label} bind`);
		},
		dispose() {
			const closed = bound.get(label)?.closed;
			calls.push(`${label} dispose${closed ? " after teardown" : ""}`);
		},
	});
	const session = await parentSession({
		streamFn: defaultDispatch,
		extensions: [
			(pi) => pi.registerTool(createSubagentIntegration(pi, view("root"))),
		],
		// A configured installation of the full extension also loads in children.
		onChildLoad: (pi) => void createSubagentIntegration(pi, view("child")),
	});
	const tree = bound.get("root");
	if (!tree) throw new Error("Missing root runtime");
	expect(calls.at(-1)).toBe("root bind");
	await session.prompt("delegate");
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(calls).toContain("child dispose");
	expect(calls).not.toContain("child bind");
	calls.length = 0;
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	expect(tree.closed).toBe(true);
	// Root presentation goes first; tearing down children then releases their unbound views.
	expect(calls).toEqual(["root dispose", "child dispose"]);
});

test.each(["session_start", "session_shutdown"] as const)(
	"%s cleans up the runtime even when view disposal throws",
	async (event) => {
		let failDispose = false;
		const { session, tree, runtime, execute } = await rootSession({
			streamFn: stream((context, options) =>
				lastText(context) === "child task"
					? waiting(options?.signal)
					: defaultDispatch.respond(context, options),
			),
			view: {
				dispose() {
					if (failDispose) throw new Error("view cleanup failed");
				},
			},
		});
		const errors: string[] = [];
		const unsubscribe = session.extensionRunner.onError((error) => {
			errors.push(error.error);
		});
		onCleanup(() => {
			failDispose = false;
			unsubscribe();
		});
		await session.prompt("delegate");
		await until(() => Boolean(tree.get("1")?.session?.isStreaming));
		const child = tree.get("1");
		failDispose = true;
		if (event === "session_start")
			await session.extensionRunner.emit({ type: event, reason: "new" });
		else await session.extensionRunner.emit({ type: event, reason: "quit" });
		expect(tree.closed).toBe(true);
		expect(tree.tree()).toHaveLength(0);
		expect(child?.status).toBe("aborted");
		expect(child?.session?.isStreaming).toBe(false);
		// The binding is gone: no rebind, and the tool refuses new work.
		expect(runtime()).toBe(tree);
		await expect(
			execute("late", { instructions: "child task" }),
		).rejects.toThrow();
		expect(completions(session)).toHaveLength(0);
		expect(errors).toEqual(["view cleanup failed"]);
	},
);
