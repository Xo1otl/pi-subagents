import { describe, expect, mock, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import {
	SUBAGENT_REMINDER_TYPE,
	SUBAGENT_RESULT_TYPE,
	type SubagentCompletionDetails,
} from "../agent/protocol.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	blockingTool,
	checkpoint,
	childExtension,
	customMessages,
	hasRunningTool,
	hierarchyStream,
	lastCompletion,
	lastCustomMessage,
	lastText,
	model,
	removeOutputOnCleanup,
	replies,
	report,
	response,
	spawnContext,
	stream,
	testRuntime,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

const echo = stream((context) => {
	const text = lastText(context);
	if (text === "monitor") return toolCall("blocking", {});
	return lastCustomMessage(context, SUBAGENT_REMINDER_TYPE)
		? report("task result")
		: response(text);
});

async function blockedMonitor() {
	const context = await spawnContext(echo);
	const blocking = await blockingTool(context);
	return { context, blocking };
}

function reminders(tree: Subagents, id: string): number {
	return (
		tree
			.get(id)
			?.session?.sessionManager.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === SUBAGENT_REMINDER_TYPE,
			).length ?? 0
	);
}

describe("runtime factory", () => {
	test("keeps IDs, subscriptions, and shutdown local to each instance", async () => {
		const first = testRuntime();
		const second = testRuntime();
		const listener = mock(() => {});
		first.subscribe(listener);
		expect(
			(await second.start(ROOT, "nest:1", await spawnContext()).result).id,
		).toBe("1");
		expect(listener).not.toHaveBeenCalled();
		expect(
			(await first.start(ROOT, "hello", await spawnContext()).result).id,
		).toBe("1");
		await first.dispose();
		expect(second.closed).toBe(false);
		await second.send("1.1", "still available");
		expect(second.get("1.1")?.status).toBe("done");
	});

	test("child sessions fence idle cache refreshes without changing the configured policy", async () => {
		const tree = testRuntime();
		let requests = 0;
		const context = await spawnContext(
			stream(() => {
				requests++;
				return report("done", {
					usage: {
						...response("").usage,
						input: 100_000,
						totalTokens: 100_002,
					},
				});
			}),
		);
		const settingsPath = join(context.agentDir, "settings.json");
		const configured = {
			...JSON.parse(await readFile(settingsPath, "utf8")),
			cacheWarming: "idle",
		};
		await writeFile(settingsPath, JSON.stringify(configured));
		context.model = {
			...model,
			promptCache: { short: 60 },
			cost: { input: 50, output: 10, cacheRead: 1, cacheWrite: 50 },
		};
		expect(await tree.start(ROOT, "task", context).result).toMatchObject({
			status: "done",
			usage: { totalTokens: 100_002 },
		});
		const child = tree.get("1")?.session;
		expect(
			await child?.extensionRunner.emitCacheWarmingDecision({
				type: "cache_warming_decision",
				action: "warm",
				warmCost: 0.01,
				missCost: 10,
				continuationProbability: 1,
			}),
		).toBe("stop");
		expect(child?.settingsManager.getCacheWarmingMode()).toBe("idle");
		expect(await readFile(settingsPath, "utf8")).toBe(
			JSON.stringify(configured),
		);
		expect(requests).toBe(1);
	});
});

describe("silent hierarchy", () => {
	test("returns the final result and keeps each conversation separate", async () => {
		const tree = testRuntime();
		const result = await tree.start(ROOT, "nest:2", await spawnContext())
			.result;
		expect(result).toMatchObject({
			id: "1",
			status: "done",
			output: "hello",
		});
		expect(
			tree
				.tree()
				.map((node) => [node.id, node.parentId, node.depth, node.status]),
		).toEqual([
			["1", ROOT, 1, "done"],
			["1.1", "1", 2, "done"],
			["1.1.1", "1.1", 3, "done"],
		]);
		const leaf = tree.get("1.1.1");
		expect(
			leaf?.session?.messages.filter((message) => message.role === "user"),
		).toHaveLength(1);
		expect(JSON.stringify(leaf?.session?.messages)).not.toContain("nest:2");
		expect(result.usage?.totalTokens).toBe(21);
		expect(result.usage?.cost.total).toBeCloseTo(0.21);
	});

	test("an idle headless parent accepts a continuation before its descendant completes and bills it in the same run", async () => {
		const tree = testRuntime();
		const leaf = checkpoint();
		const paused = stream(async (context, options) => {
			if (lastText(context) === "nest:0") await leaf.pass(options?.signal);
			return hierarchyStream.respond(context, options);
		});
		const started = tree.start(ROOT, "nest:1", await spawnContext(paused));
		await leaf.reached;
		const node = tree.get("1");
		if (!node?.session) throw new Error("Missing parent");
		await node.session.waitForIdle();
		const tools = [...node.liveTools.keys()];
		await tree.send("1", "live continuation");
		expect(Bun.peek.status(started.result)).toBe("pending");
		expect(node.status).toBe("running");
		expect(node.session.getLastAssistantText()).toBe("live continuation");
		expect([...node.liveTools.keys()]).toEqual(tools);
		leaf.open();
		expect(await started.result).toMatchObject({
			status: "done",
			output: "hello",
			usage: { totalTokens: 15 },
		});
		expect(reminders(tree, "1")).toBe(0);
		expect(node.session?.getSessionStats().tokens.total).toBe(15);
	});

	test("stopping an idle parent that drains a child stops both and keeps billed work", async () => {
		const tree = testRuntime();
		const leaf = checkpoint();
		const paused = stream(async (context, options) => {
			if (lastText(context) === "nest:0") await leaf.pass(options?.signal);
			return hierarchyStream.respond(context, options);
		});
		const result = tree.start(
			ROOT,
			"nest:1",
			await spawnContext(paused),
		).result;
		await leaf.reached;
		await tree.get("1")?.session?.waitForIdle();
		tree.abort("1");
		expect((await result).status).toBe("aborted");
		expect(tree.get("1.1")?.status).toBe("aborted");
		expect((await result).usage.totalTokens).toBe(9);
	});
});

describe("task results", () => {
	test("failed headless completion delivery is reported, billed once, and cleans its unused output file", async () => {
		const tree = testRuntime();
		const leaf = checkpoint();
		const paused = stream(async (context, options) => {
			if (lastText(context) === "nest:0") {
				await leaf.pass(options?.signal);
				return report("large output\n".repeat(3000));
			}
			return hierarchyStream.respond(context, options);
		});
		const result = tree.start(
			ROOT,
			"nest:1",
			await spawnContext(paused),
		).result;
		await leaf.reached;
		const parent = tree.get("1")?.session;
		if (!parent) throw new Error("Missing parent");
		await parent.waitForIdle();
		let path: string | undefined;
		spyOn(parent, "sendCustomMessage").mockImplementation(async (message) => {
			path = (message.details as SubagentCompletionDetails).fullOutputPath;
			if (path) removeOutputOnCleanup(path);
			throw new Error("completion sender failed");
		});
		leaf.open();
		expect(await result).toMatchObject({
			status: "error",
			error: "completion sender failed",
			usage: { totalTokens: 9 },
		});
		expect(parent.getSessionStats().tokens.total).toBe(9);
		if (!path) throw new Error("Missing output file");
		await expect(readFile(path)).rejects.toThrow();
	});

	test("subtree cancellation discards output files belonging to abandoned queued completions", async () => {
		const tree = testRuntime();
		const child = checkpoint();
		const parent = checkpoint();
		const paused = stream(async (context, options) => {
			if (lastText(context) === "nest:0") {
				await child.pass(options?.signal);
				return report("large output\n".repeat(3000));
			}
			if (lastText(context) === "busy parent")
				await parent.pass(options?.signal);
			return hierarchyStream.respond(context, options);
		});
		const result = tree.start(
			ROOT,
			"nest:1",
			await spawnContext(paused),
		).result;
		await child.reached;
		await tree.get("1")?.session?.waitForIdle();
		const sent = tree.send("1", "busy parent");
		await parent.reached;
		child.open();
		const session = tree.get("1")?.session;
		let path: string | undefined;
		await until(() => {
			const message = session?.agent
				.peekQueuedMessages()
				.find((message) => message.role === "custom");
			if (message?.role !== "custom") return false;
			path = (message.details as SubagentCompletionDetails).fullOutputPath;
			return Boolean(path);
		});
		if (!path) throw new Error("Missing queued output file");
		removeOutputOnCleanup(path);
		tree.abort("1");
		expect(await result).toMatchObject({
			status: "aborted",
			usage: { totalTokens: 12 },
		});
		await sent;
		await expect(readFile(path)).rejects.toThrow();
		expect(session?.agent.peekQueuedMessages()).toHaveLength(0);
	});

	test("a report while children run is refused, naming them, until their results have reached the agent", async () => {
		const tree = testRuntime();
		const child = checkpoint();
		let refusal = "";
		const started = tree.start(
			ROOT,
			"delegate, then report",
			await spawnContext(
				stream(async (context, options) => {
					const text = lastText(context);
					if (text === "delegate, then report")
						return toolCall("subagent", { instructions: "child task" });
					if (text === "child task") {
						await child.pass(options?.signal);
						return report("child done");
					}
					if (lastCustomMessage(context, SUBAGENT_RESULT_TYPE))
						return report("parent done, with the child's result");
					const last = context.messages.at(-1);
					if (last?.role === "toolResult" && last.toolName === "subagent")
						return report("parent done early");
					refusal = text;
					return response("waiting for the child");
				}),
			),
		);
		await until(
			() =>
				tree.get("1")?.session?.isIdle === true &&
				tree.get("1")?.session?.getLastAssistantText() ===
					"waiting for the child",
		);
		expect(refusal).toContain("1.1");
		expect(tree.get("1")?.status).toBe("running");
		expect(tree.get("1.1")?.status).toBe("running");
		child.open();
		expect(await started.result).toMatchObject({
			status: "done",
			output: "parent done, with the child's result",
		});
		expect(tree.get("1.1")?.status).toBe("done");
	});

	test("a report in a conversation the user continued is not delivered, and says so", async () => {
		const tree = testRuntime();
		const context = await spawnContext(stream(() => report("again")));
		await tree.start(ROOT, "task", context).result;
		await tree.send("1", "report again");
		expect(tree.get("1")?.status).toBe("done");
		expect(tree.get("1")?.session?.messages.at(-1)).toMatchObject({
			role: "toolResult",
			isError: true,
		});
	});

	test("returns the full report, without bounds or presentation hints", async () => {
		const tree = testRuntime();
		const huge = `one\n${"日本語".repeat(20_000)}`;
		const result = await tree.start(
			ROOT,
			"large",
			await spawnContext(stream(() => report(huge))),
		).result;
		expect(result.output).toBe(huge);
	});

	test("an unreported task is reminded once, then fails with its last message", async () => {
		const tree = testRuntime();
		let requests = 0;
		const result = await tree.start(
			ROOT,
			"question",
			await spawnContext(
				stream(() => {
					requests++;
					return response("Should I proceed?");
				}),
			),
		).result;
		expect(result).toMatchObject({
			status: "error",
			error: expect.any(String),
		});
		expect(result.output).toContain("Should I proceed?");
		expect(reminders(tree, "1")).toBe(1);
		expect(requests).toBe(2);
	});
});

describe("interaction and cleanup", () => {
	test("steering at settlement is drained and answered, then the task reports the final result", async () => {
		const tree = testRuntime();
		let sent = false;
		let subscribed = false;
		tree.subscribe(() => {
			const session = tree.get("1")?.session;
			if (!session || subscribed) return;
			subscribed = true;
			session.agent.subscribe((event) => {
				if (event.type === "agent_end" && !sent) {
					sent = true;
					void tree.send("1", "late steering");
				}
			});
		});
		const result = tree.start(ROOT, "initial", await spawnContext(echo)).result;
		expect((await result).output).toBe("task result");
		expect(replies(tree.get("1")?.session?.messages)).toEqual([
			"initial",
			"late steering",
		]);
		expect(reminders(tree, "1")).toBe(1);
		expect(tree.get("1")?.session?.pendingMessageCount).toBe(0);
	});

	test("input sent during a long-running tool stays queued and visible, then steers; its answer is no report, so the task is reminded", async () => {
		const tree = testRuntime();
		const { context, blocking } = await blockedMonitor();
		const result = tree.start(ROOT, "monitor", context).result;
		const node = tree.get("1");
		const statuses: (string | undefined)[] = [];
		tree.subscribe(() => {
			if (node?.status !== statuses.at(-1)) statuses.push(node?.status);
		});
		expect(node?.queuedInput).toEqual([]);
		await blocking.reached;
		expect(hasRunningTool(node)).toBe(true);
		const sent = tree.send("1", "are you there?");
		expect(node?.queuedInput).toEqual(["are you there?"]);
		await sent;
		expect(node?.queuedInput).toEqual(["are you there?"]);
		blocking.open();
		expect(await result).toMatchObject({
			status: "done",
			output: "task result",
		});
		expect(replies(tree.get("1")?.session?.messages)).toEqual([
			"are you there?",
		]);
		expect(reminders(tree, "1")).toBe(1);
		expect(statuses).toEqual(["running", "done"]);
		expect(node?.queuedInput).toEqual([]);
	});

	test("stopping returns sent input that never reached the agent, not its task", async () => {
		const tree = testRuntime();
		const { context, blocking } = await blockedMonitor();
		const early = tree.start(ROOT, "monitor", context);
		const pending = tree.send("1", "before startup");
		expect(tree.get("1")?.queuedInput).toEqual(["before startup"]);
		expect(tree.abort("1")).toEqual(new Map([["1", ["before startup"]]]));
		await pending;
		expect((await early.result).status).toBe("aborted");
		expect(
			JSON.stringify(tree.get("1")?.session?.messages ?? []),
		).not.toContain("before startup");

		const steered = tree.start(ROOT, "monitor", context);
		const node = tree.get("2");
		await blocking.reached;
		expect(hasRunningTool(node)).toBe(true);
		await tree.send("2", "first");
		await tree.send("2", "second");
		expect(tree.abort("2")).toEqual(new Map([["2", ["first", "second"]]]));
		expect(node?.queuedInput).toEqual([]);
		expect((await steered.result).status).toBe("aborted");
	});

	test("input stopped inside slow input hooks is handed back without reaching the agent", async () => {
		const tree = testRuntime();
		const { context, blocking } = await blockedMonitor();
		const hook = checkpoint();
		await childExtension(context, "input", (pi) => {
			pi.on("input", async (event) => {
				if (event.text === "in flight") await hook.pass();
			});
		});
		const result = tree.start(ROOT, "monitor", context).result;
		const node = tree.get("1");
		await blocking.reached;
		expect(hasRunningTool(node)).toBe(true);
		const sent = tree.send("1", "in flight");
		await hook.reached;
		expect(tree.abort("1")).toEqual(new Map([["1", ["in flight"]]]));
		hook.open();
		await sent;
		expect((await result).status).toBe("aborted");
		expect(JSON.stringify(node?.session?.messages)).not.toContain("in flight");
		expect(node?.session?.pendingMessageCount).toBe(0);
	});

	test("parent cancellation aborts all descendants, not independent siblings", async () => {
		const tree = testRuntime();
		const paused = stream((context, options) => {
			if (lastText(context) === "parent")
				return toolCall("subagent", { instructions: "waiting" });
			return waiting(options?.signal);
		});
		const parent = tree.start(
			ROOT,
			"parent",
			await spawnContext(paused),
		).result;
		const sibling = tree.start(
			ROOT,
			"sibling",
			await spawnContext(paused),
		).result;
		await until(() => Boolean(tree.get("1.1")?.session?.isStreaming));
		tree.abort("1");
		expect((await parent).status).toBe("aborted");
		expect(tree.get("1")?.status).toBe("aborted");
		expect(tree.get("1.1")?.status).toBe("aborted");
		expect(tree.get("2")?.status).toBe("running");
		tree.abort("2");
		await sibling;
	});

	test.each(["quit", "new"] as const)(
		"a subagent whose own session ends (%s) stops its children, and its run only when quitting",
		async (reason) => {
			const tree = testRuntime();
			const context = await spawnContext(
				stream((context, options) => {
					const text = lastText(context);
					if (text === "parent")
						return toolCall("subagent", { instructions: "waiting" });
					if (text === "waiting") return waiting(options?.signal);
					return lastCustomMessage(context, SUBAGENT_REMINDER_TYPE)
						? report("parent carried on")
						: response("waiting for the child");
				}),
			);
			const parent = tree.start(ROOT, "parent", context).result;
			await until(() => tree.get("1.1")?.session?.isStreaming === true);
			await tree.get("1")?.session?.extensionRunner.emit({
				type: "session_shutdown",
				reason,
			});
			expect(await parent).toMatchObject(
				reason === "quit"
					? { status: "aborted" }
					: { status: "done", output: "parent carried on" },
			);
			expect(tree.get("1.1")?.status).toBe("aborted");
			expect(
				tree
					.get("1")
					?.session?.messages.some(
						(message) =>
							message.role === "custom" &&
							message.customType === SUBAGENT_RESULT_TYPE,
					),
			).toBe(false);
		},
	);

	test("UI subtree abort covers restarted descendants and supports restarting after stop", async () => {
		const tree = testRuntime();
		const context = await spawnContext(
			stream((context, options) =>
				lastText(context) === "wait"
					? waiting(options?.signal)
					: hierarchyStream.respond(context, options),
			),
		);
		await tree.start(ROOT, "nest:1", context).result;
		const leaf = tree.get("1.1");
		const restarted = tree.send("1.1", "wait");
		await until(() => leaf?.session?.isStreaming === true);
		tree.abort("1");
		await restarted;
		expect(leaf?.status).toBe("aborted");
		await tree.send("1.1", "say hello");
		expect(leaf?.status).toBe("done");
	});

	test("interrupting a task's turn keeps its run: it waits, unreminded, for input that resumes it, and still reports", async () => {
		const tree = testRuntime();
		const { context, blocking } = await blockedMonitor();
		const started = tree.start(ROOT, "monitor", context);
		const node = tree.get("1");
		await blocking.reached;
		expect(tree.interrupt("1")).toEqual([]);
		expect(node).toMatchObject({
			status: "running",
			interrupted: true,
			cancelled: false,
		});
		await tree.settled("1");
		await node?.session?.waitForIdle();
		expect(Bun.peek.status(started.result)).toBe("pending");
		expect(reminders(tree, "1")).toBe(0);
		await tree.send("1", "carry on");
		expect(node?.interrupted).toBe(false);
		expect(await started.result).toMatchObject({
			status: "done",
			output: "task result",
		});
		expect(replies(node?.session?.messages)).toEqual(["carry on"]);
		expect(reminders(tree, "1")).toBe(1);
	});

	test("an interrupt hands back queued input once; input sent at once waits for the interrupted turn to end", async () => {
		const tree = testRuntime();
		const { context, blocking } = await blockedMonitor();
		const started = tree.start(ROOT, "monitor", context);
		const node = tree.get("1");
		await blocking.reached;
		expect(hasRunningTool(node)).toBe(true);
		await tree.send("1", "first");
		expect(tree.interrupt("1")).toEqual(["first"]);
		expect(tree.interrupt("1")).toEqual([]);
		expect(node?.queuedInput).toEqual([]);
		const resumed = tree.send("1", "second");
		expect(node?.queuedInput).toEqual(["second"]);
		await resumed;
		expect(await started.result).toMatchObject({
			status: "done",
			output: "task result",
		});
		expect(replies(node?.session?.messages)).toEqual(["second"]);
	});

	test.each([
		["queued before the interrupt", true, true],
		["arriving after an interrupted turn", true, false],
		["arriving while the parent idles", false, false],
	] as const)(
		"a child's result %s waits for the parent's next input instead of restarting it",
		async (_case, busy, early) => {
			const tree = testRuntime();
			const child = checkpoint();
			const context = await spawnContext(
				stream(async (context, options) => {
					const text = lastText(context);
					const completion = lastCompletion(context);
					const last = context.messages.at(-1);
					if (completion) return report(`parent saw ${completion.output}`);
					if (text === "parent task")
						return toolCall("subagent", { instructions: "child task" });
					if (text === "child task") {
						await child.pass(options?.signal);
						return report("child answer");
					}
					if (last?.role === "toolResult" && last.toolName === "subagent")
						return busy
							? toolCall("blocking", {})
							: response("waiting for the child");
					return response(text);
				}),
			);
			const blocking = await blockingTool(context);
			const started = tree.start(ROOT, "parent task", context);
			await child.reached;
			const parent = tree.get("1")?.session;
			if (!parent) throw new Error("Missing parent");
			const results = () =>
				customMessages(parent.messages, SUBAGENT_RESULT_TYPE);
			if (busy) await blocking.reached;
			else await parent.waitForIdle();
			if (early) {
				child.open();
				await until(() => parent.agent.hasQueuedMessages());
			}
			tree.interrupt("1");
			await parent.waitForIdle();
			const transcript = parent.messages.length;
			child.open();
			await tree.settled("1");
			await parent.waitForIdle();
			expect(tree.get("1.1")?.status).toBe("done");
			expect(Bun.peek.status(started.result)).toBe("pending");
			expect(parent.messages).toHaveLength(transcript);
			expect(results()).toHaveLength(0);
			await tree.send("1", "resume");
			expect(await started.result).toMatchObject({
				status: "done",
				output: "parent saw child answer",
			});
			expect(results()).toHaveLength(1);
		},
	);

	test("a result the parent already received is not delivered again by a later interrupt", async () => {
		const tree = testRuntime();
		const child = checkpoint();
		let seen = 0;
		const context = await spawnContext(
			stream(async (context, options) => {
				const text = lastText(context);
				const last = context.messages.at(-1);
				if (lastCompletion(context))
					return ++seen === 1 ? toolCall("waiting", {}) : report("twice");
				if (text === "parent task")
					return toolCall("subagent", { instructions: "child task" });
				if (text === "child task") {
					await child.pass(options?.signal);
					return report("child answer");
				}
				if (last?.role === "toolResult" && last.toolName === "subagent")
					return toolCall("blocking", {});
				if (text === "resume") return report("once");
				return response("noted");
			}),
		);
		const release = await blockingTool(context);
		await childExtension(context, "waiting", (pi) => {
			pi.registerTool({
				name: "waiting",
				label: "Waiting",
				description: "Waits until aborted",
				parameters: Type.Object({}),
				execute: (_id, _args, signal) => waiting(signal),
			});
		});
		const started = tree.start(ROOT, "parent task", context);
		const parent = tree.get("1");
		await Promise.all([child.reached, release.reached]);
		child.open();
		await until(() => parent?.session?.agent.hasQueuedMessages() === true);
		release.open();
		await until(() => seen === 1 && hasRunningTool(parent));
		tree.interrupt("1");
		await tree.send("1", "resume");
		expect(await started.result).toMatchObject({
			status: "done",
			output: "once",
		});
		expect(
			customMessages(parent?.session?.messages, SUBAGENT_RESULT_TYPE),
		).toHaveLength(1);
	});

	test("shutdown requested by lifecycle listeners waits for the whole run and is reentrant", async () => {
		const tree = testRuntime();
		const closings: Promise<void>[] = [];
		tree.subscribe(() => {
			if (tree.get("1")) closings.push(tree.dispose());
		});
		const result = tree.start(ROOT, "hello", await spawnContext()).result;
		await closings[0];
		expect(closings.length).toBeGreaterThan(1);
		expect(new Set(closings).size).toBe(1);
		expect((await result).status).toBe("aborted");
		expect(tree.tree()).toHaveLength(0);
	});
});
