import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Provider, Usage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	createSubagentIntegration,
	type SubagentView,
} from "../agent/index.ts";
import {
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_USAGE_TYPE,
	type SubagentCompletionDetails,
} from "../agent/protocol.ts";
import { spawnContext } from "../agent/sessions.ts";
import type { Subagents } from "../runtime/index.ts";
import { SUBAGENT_USAGE_KIND } from "../runtime/summary.ts";
import {
	deferred,
	lastText,
	model,
	parentSession,
	response,
	stream,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

const parents: { session: AgentSession; tree: Subagents }[] = [];
const releaseGates: (() => void)[] = [];
const outputDirectories: string[] = [];
function gate() {
	const result = deferred();
	releaseGates.push(() => result.resolve());
	return result;
}

afterEach(async () => {
	for (const release of releaseGates.splice(0)) release();
	for (const { session, tree } of parents.splice(0)) {
		try {
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
		} catch {
			/* A test may have deliberately invalidated the runner. */
		}
		await tree.dispose();
		session.dispose();
	}
	await Promise.all(
		outputDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

/** A root integration whose view exposes the runtime bound to the current session. */
function rootIntegration(view: Partial<SubagentView> = {}) {
	let tool!: ReturnType<typeof createSubagentIntegration>;
	let bound: Subagents | undefined;
	const factory: ExtensionFactory = (pi) => {
		tool = createSubagentIntegration(pi, {
			bind(runtime, ctx) {
				bound = runtime;
				view.bind?.(runtime, ctx);
			},
			dispose: () => view.dispose?.(),
		});
		pi.registerTool(tool);
	};
	const runtime = () => {
		if (!bound) throw new Error("Missing runtime");
		return bound;
	};
	return { factory, tool: () => tool, runtime };
}

async function setup(
	dispatch: Provider["streamSimple"],
	onChildStart?: (ctx: ExtensionContext) => Promise<void>,
	hooks: { parent?: ExtensionFactory; child?: ExtensionFactory } = {},
) {
	const root = rootIntegration();
	const session = await parentSession(
		dispatch,
		[...(hooks.parent ? [hooks.parent] : []), root.factory],
		onChildStart,
		hooks.child,
	);
	const tree = root.runtime();
	parents.push({ session, tree });
	return { session, tree, tool: root.tool, runtime: root.runtime };
}

function completions(session: AgentSession) {
	return session.messages
		.filter((message) => message.role === "custom")
		.filter((message) => message.customType === SUBAGENT_RESULT_TYPE);
}
function completionDetails(session: AgentSession): SubagentCompletionDetails {
	const message = completions(session).at(-1);
	if (message?.role !== "custom") throw new Error("Missing completion");
	return message.details as SubagentCompletionDetails;
}

const defaultDispatch = stream((context) => {
	const text = lastText(context);
	if (text === "delegate")
		return toolCall("subagent", { instructions: "child task" });
	if (context.messages.at(-1)?.role === "toolResult")
		return response("parent available");
	if (text.startsWith("Subagent ")) return response("completion accepted");
	return response(
		text === "child task" ? "child answer" : "another prompt accepted",
	);
});

test("root returns a receipt and accepts another prompt while child session initialization is blocked", async () => {
	const initialized = gate();
	let initializing = false;
	const { session, tree } = await setup(defaultDispatch, async () => {
		initializing = true;
		await initialized.promise;
	});
	let parentFinished = false;
	const prompt = session.prompt("delegate").then(() => {
		parentFinished = true;
	});
	await until(() => parentFinished);
	await prompt;
	expect(session.getLastAssistantText()).toBe("parent available");
	const receipt = session.messages.find(
		(message) => message.role === "toolResult",
	);
	if (receipt?.role !== "toolResult") throw new Error("Missing receipt");
	expect(receipt.details).toEqual({
		id: "1",
		status: "running",
	});
	expect(receipt.content).toEqual([
		{ type: "text", text: JSON.stringify(receipt.details) },
	]);
	expect(receipt.usage).toBeUndefined();
	expect(completions(session)).toHaveLength(0);
	expect(tree.get("1")?.status).toBe("running");
	await session.prompt("another prompt");
	expect(session.getLastAssistantText()).toBe("another prompt accepted");
	await until(() => initializing);
	initialized.resolve();
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(completionDetails(session)).toMatchObject({
		id: "1",
		status: "done",
		usage: { totalTokens: 3 },
	});
	expect(session.getLastAssistantText()).toBe("completion accepted");
	expect(session.getSessionStats().tokens.total).toBe(15);
	expect(
		session.sessionManager
			.getEntries()
			.filter(
				(entry) => entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND,
			),
	).toHaveLength(1);
});

test("completion is a follow-up to a busy parent's newer prompt, not an interruption", async () => {
	const child = gate();
	const parent = gate();
	let childRunning = false;
	let parentRunning = false;
	let completionRequests = 0;
	const dispatch = stream(async (context, options) => {
		const text = lastText(context);
		if (text === "child task") {
			childRunning = true;
			await Promise.race([child.promise, waiting(options?.signal)]);
			return response("child answer");
		}
		if (text === "busy prompt") {
			parentRunning = true;
			await Promise.race([parent.promise, waiting(options?.signal)]);
			return response("newer prompt finished");
		}
		if (text.startsWith("Subagent ")) {
			completionRequests++;
			return response("completion accepted");
		}
		return defaultDispatch(model, context, options).result();
	});
	const { session, tree } = await setup(dispatch);
	await session.prompt("delegate");
	await until(() => childRunning);
	const busy = session.prompt("busy prompt");
	await until(() => parentRunning);
	child.resolve();
	await until(() => tree.get("1")?.status === "done");
	await Bun.sleep(10);
	// Held by the integration, so an interrupt clearing pi's queue cannot drop it.
	expect(session.agent.hasQueuedMessages()).toBe(false);
	expect(completions(session)).toHaveLength(0);
	expect(completionRequests).toBe(0);
	parent.resolve();
	await busy;
	await session.waitForIdle();
	expect(completions(session)).toHaveLength(1);
	const texts = session.messages.flatMap((message) =>
		message.role === "assistant"
			? message.content.flatMap((part) =>
					part.type === "text" ? [part.text] : [],
				)
			: [],
	);
	expect(texts.slice(-2)).toEqual([
		"newer prompt finished",
		"completion accepted",
	]);
});

test("provider errors are delivered after the receipt with usage and a terminal error status", async () => {
	const dispatch = stream((context, options) => {
		if (lastText(context) === "child task")
			throw new Error("provider unavailable");
		return defaultDispatch(model, context, options).result();
	});
	const { session, tree } = await setup(dispatch);
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
	const child = gate();
	let running = false;
	let aborted = false;
	const dispatch = stream(async (context, options) => {
		if (lastText(context) === "child task") {
			running = true;
			options?.signal?.addEventListener("abort", () => {
				aborted = true;
			});
			await Promise.race([child.promise, waiting(options?.signal)]);
			return response("child answer");
		}
		return defaultDispatch(model, context, options).result();
	});
	const { session, tree, tool } = await setup(dispatch);
	const cancelled = new AbortController();
	cancelled.abort(new Error("already cancelled"));
	await expect(
		tool().execute(
			"rejected",
			{ instructions: "child task" },
			cancelled.signal,
			undefined,
			session.extensionRunner.createToolContext("rejected", cancelled.signal),
		),
	).rejects.toThrow("already cancelled");
	expect(tree.tree()).toHaveLength(0);
	const controller = new AbortController();
	const receipt = await tool().execute(
		"detached",
		{ instructions: "child task" },
		controller.signal,
		undefined,
		session.extensionRunner.createToolContext("detached", controller.signal),
	);
	expect(receipt.details).toMatchObject({ id: "1", status: "running" });
	controller.abort();
	await until(() => running);
	expect(tree.get("1")?.cancelled).toBe(false);
	expect(aborted).toBe(false);
	tree.abort("1");
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(aborted).toBe(true);
	expect(completionDetails(session)).toMatchObject({
		status: "aborted",
		error: "Subagent was aborted.",
		usage: { totalTokens: 3 },
	});
});

test("interrupting the originating parent leaves the child running and still delivers its result", async () => {
	const child = gate();
	let childRunning = false;
	const dispatch = stream(async (context, options) => {
		const text = lastText(context);
		if (text === "child task") {
			childRunning = true;
			await Promise.race([child.promise, waiting(options?.signal)]);
			return response("late child answer");
		}
		if (context.messages.at(-1)?.role === "toolResult")
			return waiting(options?.signal);
		return defaultDispatch(model, context, options).result();
	});
	const { session, tree } = await setup(dispatch);
	const prompt = session.prompt("delegate");
	await until(
		() =>
			childRunning &&
			session.messages.some((message) => message.role === "toolResult"),
	);
	// Pi's interactive interrupt clears queued messages before aborting.
	session.clearQueue();
	await session.abort();
	await prompt;
	expect(tree.get("1")?.cancelled).toBe(false);
	await session.prompt("corrected prompt");
	expect(session.getLastAssistantText()).toBe("another prompt accepted");
	child.resolve();
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(completionDetails(session)).toMatchObject({ id: "1", status: "done" });
	expect(session.getLastAssistantText()).toBe("completion accepted");
	expect(
		session.sessionManager
			.getEntries()
			.filter(
				(entry) => entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND,
			),
	).toHaveLength(1);
});

test("a result arriving during an interrupt is kept without restarting the turn", async () => {
	const child = gate();
	const agentEnd = gate();
	const ending = deferred();
	let childRunning = false;
	let parentRunning = false;
	let completionRequests = 0;
	let resultInContext = false;
	const dispatch = stream(async (context, options) => {
		const text = lastText(context);
		if (text === "child task") {
			childRunning = true;
			await Promise.race([child.promise, waiting(options?.signal)]);
			return response("child answer");
		}
		if (text === "newer root prompt") {
			parentRunning = true;
			return waiting(options?.signal);
		}
		if (text.startsWith("Subagent ")) completionRequests++;
		if (text === "another prompt")
			resultInContext = JSON.stringify(context.messages).includes(
				"child answer",
			);
		return defaultDispatch(model, context, options).result();
	});
	const { session, tree } = await setup(dispatch, undefined, {
		parent: (pi) => {
			pi.on("agent_end", async (_event, ctx) => {
				if (ctx.signal?.aborted) {
					ending.resolve();
					await agentEnd.promise;
				}
			});
		},
	});
	await session.prompt("delegate");
	await until(() => childRunning);
	const prompt = session.prompt("newer root prompt");
	await until(() => parentRunning);
	session.clearQueue();
	const aborted = session.abort();
	await ending.promise;
	child.resolve();
	await until(() =>
		session.sessionManager
			.getEntries()
			.some(
				(entry) => entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND,
			),
	);
	expect(tree.get("1")?.status).toBe("done");
	expect(completions(session)).toHaveLength(0);
	agentEnd.resolve();
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

test("a result waiting for a busy parent survives an interrupt", async () => {
	const child = gate();
	let childRunning = false;
	let parentRunning = false;
	let completionRequests = 0;
	const dispatch = stream(async (context, options) => {
		const text = lastText(context);
		if (text === "child task") {
			childRunning = true;
			await Promise.race([child.promise, waiting(options?.signal)]);
			return response("child answer");
		}
		if (text === "busy prompt") {
			parentRunning = true;
			return waiting(options?.signal);
		}
		if (text.startsWith("Subagent ")) completionRequests++;
		return defaultDispatch(model, context, options).result();
	});
	const { session, tree } = await setup(dispatch);
	await session.prompt("delegate");
	await until(() => childRunning);
	const busy = session.prompt("busy prompt");
	await until(() => parentRunning);
	child.resolve();
	await until(() => tree.get("1")?.status === "done");
	await Bun.sleep(10);
	expect(completions(session)).toHaveLength(0);
	session.clearQueue();
	await session.abort();
	await busy;
	expect(completions(session)).toHaveLength(1);
	expect(completionRequests).toBe(0);
	expect(session.isIdle).toBe(true);
});

test("results held by a busy parent are released together, starting one turn", async () => {
	const parent = gate();
	let parentRunning = false;
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
			return response(`${text} answer`);
		}
		if (context.messages.at(-1)?.role === "toolResult") {
			parentRunning = true;
			await Promise.race([parent.promise, waiting(options?.signal)]);
			return response("parent finished");
		}
		if (text.startsWith("Subagent ")) {
			completionRequests++;
			return response("completions accepted");
		}
		return defaultDispatch(model, context, options).result();
	});
	const { session, tree } = await setup(dispatch);
	const prompt = session.prompt("delegate twice");
	await until(
		() =>
			parentRunning &&
			children === 2 &&
			tree.tree().every((node) => node.status === "done"),
	);
	await Bun.sleep(10);
	expect(completions(session)).toHaveLength(0);
	parent.resolve();
	await prompt;
	await session.waitForIdle();
	expect(completions(session)).toHaveLength(2);
	expect(completionRequests).toBe(1);
	expect(session.getLastAssistantText()).toBe("completions accepted");
});

test("a one-shot root settles only after delegated results are delivered and answered", async () => {
	const child = gate();
	const dispatch = stream(async (context, options) => {
		if (lastText(context) === "child task") {
			await Promise.race([child.promise, waiting(options?.signal)]);
			return response("child answer");
		}
		return defaultDispatch(model, context, options).result();
	});
	const root = rootIntegration();
	const session = await parentSession(
		dispatch,
		[root.factory],
		undefined,
		undefined,
		"print",
	);
	const tree = root.runtime();
	parents.push({ session, tree });
	let finished = false;
	const prompt = session.prompt("delegate").then(() => {
		finished = true;
	});
	await until(() => Boolean(tree.get("1")?.session?.isStreaming));
	await Bun.sleep(10);
	expect(finished).toBe(false);
	expect(completions(session)).toHaveLength(0);
	child.resolve();
	await prompt;
	expect(tree.get("1")?.status).toBe("done");
	expect(completions(session)).toHaveLength(1);
	expect(session.getLastAssistantText()).toBe("completion accepted");
});

test("accounting preserves other extensions' boundary drafts both with and without completion metadata", async () => {
	const child = gate();
	const { session } = await setup(defaultDispatch, async () => child.promise, {
		parent: (pi) => {
			pi.on("turn_end", (event) => ({
				entries: [
					...event.entries,
					{ type: "custom", customType: "prior-turn", data: true },
				],
			}));
			pi.on("agent_before_settle", (event) => ({
				entries: [
					...event.entries,
					{ type: "custom", customType: "prior-settle", data: true },
				],
			}));
		},
	});
	const metadata = (kind: string) =>
		session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === kind);
	await session.prompt("delegate");
	expect(metadata("prior-turn")).toHaveLength(2);
	expect(metadata("prior-settle")).toHaveLength(1);
	child.resolve();
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(metadata("prior-turn")).toHaveLength(3);
	expect(metadata("prior-settle")).toHaveLength(2);
	expect(metadata(SUBAGENT_USAGE_TYPE)).toHaveLength(1);
});

test.each([false, true])(
	"an accepted steering input hook is included in settlement (disposal: %s)",
	async (dispose) => {
		const original = gate();
		const input = gate();
		const entered = deferred();
		let running = false;
		const dispatch = stream(async (context, options) => {
			if (lastText(context) === "original") {
				running = true;
				await Promise.race([original.promise, waiting(options?.signal)]);
			}
			return response(lastText(context));
		});
		const { session, tree } = await setup(dispatch, undefined, {
			child: (pi) => {
				pi.on("input", async (event) => {
					if (event.text === "late input") {
						entered.resolve();
						await input.promise;
					}
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
		await until(() => running);
		const node = tree.get(started.id);
		if (!node) throw new Error("Missing child");
		let completed = false;
		void started.result.then(() => {
			completed = true;
		});
		const sent = tree.send(started.id, "late input");
		await entered.promise;
		original.resolve();
		await until(() => Boolean(node.session?.isIdle));
		// One loop turn ensures settlement gets a chance; the gated input still belongs to it.
		await Bun.sleep(10);
		expect(completed).toBe(false);
		if (!dispose) {
			input.resolve();
			await sent;
			expect(await started.result).toMatchObject({
				status: "done",
				output: "late input",
				usage: { totalTokens: 6 },
			});
			return;
		}
		const closing = tree.dispose();
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await Bun.sleep(10);
		expect(closed).toBe(false);
		input.resolve();
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
	const { session, tree, tool } = await setup(defaultDispatch, undefined, {
		child: (pi) => {
			pi.registerCommand("fail", {
				description: "Fail deterministically",
				handler: async () => {
					throw new Error("command failed");
				},
			});
		},
	});
	await tool().execute(
		"command",
		{ instructions: "/fail" },
		undefined,
		undefined,
		session.extensionRunner.createToolContext("command", undefined),
	);
	await until(() => completions(session).length === 1 && session.isIdle);
	expect(completionDetails(session)).toMatchObject({
		status: "error",
		error: "command failed",
	});
	expect(tree.get("1")?.status).toBe("error");
});

test("disposing a parent without session_shutdown suppresses delivery through its stale extension context", async () => {
	const child = gate();
	const { session, tree } = await setup(defaultDispatch, async () => {
		await child.promise;
	});
	await session.prompt("delegate");
	session.dispose();
	child.resolve();
	await until(() => tree.get("1")?.status === "done");
	await tree.dispose();
	expect(completions(session)).toHaveLength(0);
	expect(
		session.sessionManager
			.getEntries()
			.filter(
				(entry) => entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND,
			),
	).toHaveLength(1);
});

test("shutdown preserves billed child usage in the old parent's ledger without triggering a late turn", async () => {
	let running = false;
	const dispatch = stream((context, options) => {
		if (lastText(context) === "child task") {
			running = true;
			return waiting(options?.signal);
		}
		return defaultDispatch(model, context, options).result();
	});
	const { session, tree } = await setup(dispatch);
	await session.prompt("delegate");
	await until(() => running);
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	expect(tree.closed).toBe(true);
	expect(completions(session)).toHaveLength(0);
	expect(session.getSessionStats().tokens.total).toBe(9);
	const usage = session.sessionManager
		.getEntries()
		.filter(
			(entry) => entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND,
		);
	expect(usage).toHaveLength(1);
	expect(usage[0]?.type === "usage" && usage[0].usage.totalTokens).toBe(3);
	expect(session.getLastAssistantText()).toBe("parent available");
});

test("session_start replacement without prior shutdown also fences pending results", async () => {
	const child = gate();
	const { session, tree, runtime } = await setup(defaultDispatch, async () => {
		await child.promise;
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
	await runtime().dispose();
});

test("reload cancels and fences old results while the reloaded integration can spawn again", async () => {
	const child = gate();
	const { session, tree, runtime } = await setup(defaultDispatch, async () => {
		await child.promise;
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
	await runtime().dispose();
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
		if (lastText(context) === "child task") return response(huge, { usage });
		return defaultDispatch(model, context, options).result();
	});
	const { session } = await setup(dispatch);
	await session.prompt("delegate");
	await until(() => completions(session).length === 1 && session.isIdle);
	const completion = completions(session)[0];
	const details = completionDetails(session);
	if (!details.fullOutputPath) throw new Error("Missing full output file");
	outputDirectories.push(dirname(details.fullOutputPath));
	expect(await readFile(details.fullOutputPath, "utf8")).toBe(huge);
	const content = completion?.content;
	const text =
		typeof content === "string"
			? content
			: (content
					?.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n") ?? "");
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
	const entries = session.sessionManager.getEntries();
	expect(
		entries.filter(
			(entry) => entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND,
		),
	).toHaveLength(1);
	const accounting = entries.filter(
		(entry) => entry.type === "custom" && entry.customType === "subagent-usage",
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
	const session = await parentSession(
		defaultDispatch,
		[(pi) => pi.registerTool(createSubagentIntegration(pi, view("root")))],
		undefined,
		// A configured installation of the full extension also loads in children.
		(pi) => void createSubagentIntegration(pi, view("child")),
	);
	const tree = bound.get("root");
	if (!tree) throw new Error("Missing root runtime");
	parents.push({ session, tree });
	expect(calls).toEqual(["root dispose", "root bind"]);
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
		const root = rootIntegration({
			dispose() {
				if (failDispose) throw new Error("view cleanup failed");
			},
		});
		const dispatch = stream((context, options) =>
			lastText(context) === "child task"
				? waiting(options?.signal)
				: defaultDispatch(model, context, options).result(),
		);
		const session = await parentSession(dispatch, [root.factory]);
		const tree = root.runtime();
		parents.push({ session, tree });
		const errors: string[] = [];
		const unsubscribe = session.extensionRunner.onError((error) => {
			errors.push(error.error);
		});
		try {
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
			expect(root.runtime()).toBe(tree);
			await expect(
				root
					.tool()
					.execute(
						"late",
						{ instructions: "child task" },
						undefined,
						undefined,
						session.extensionRunner.createToolContext("late", undefined),
					),
			).rejects.toThrow("no longer active");
			expect(completions(session)).toHaveLength(0);
			expect(errors).toEqual(["view cleanup failed"]);
		} finally {
			failDispose = false;
			unsubscribe();
		}
	},
);
