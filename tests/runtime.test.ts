import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSubagentRuntime } from "../agent/index.ts";
import type { SubagentCompletionDetails } from "../agent/protocol.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	deferred,
	hierarchyStream,
	lastText,
	model,
	response,
	spawnContext,
	stream,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

const runtimes: Subagents[] = [];
function runtime(): Subagents {
	const tree = createSubagentRuntime();
	runtimes.push(tree);
	return tree;
}
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((tree) => tree.dispose()));
});

describe("runtime factory", () => {
	test("keeps IDs, subscriptions, and shutdown local to each instance", async () => {
		const first = runtime();
		const second = runtime();
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
		const tree = runtime();
		let requests = 0;
		const context = await spawnContext(
			stream(() => {
				requests++;
				return response("done", {
					usage: {
						...response("").usage,
						input: 100_000,
						totalTokens: 100_002,
					},
				});
			}),
		);
		if (!context.agentDir) throw new Error("Missing agent directory");
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

	test("reentrant shutdown listeners receive the same closing promise", async () => {
		const tree = runtime();
		const result = tree.start(
			ROOT,
			"wait",
			await spawnContext(
				stream((_context, options) => waiting(options?.signal)),
			),
		).result;
		await until(() => Boolean(tree.get("1")?.session?.isStreaming));
		const closings: Promise<void>[] = [];
		tree.subscribe(() => {
			if (tree.closed) closings.push(tree.dispose());
		});
		const closed = tree.dispose();
		await closed;
		expect(closings.length).toBeGreaterThan(0);
		for (const closing of closings) expect(closing).toBe(closed);
		expect((await result).status).toBe("aborted");
		expect(tree.tree()).toHaveLength(0);
	});
});

describe("silent hierarchy", () => {
	test("returns the final result and keeps each conversation separate", async () => {
		const tree = runtime();
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
		expect(leaf?.session?.model).toEqual(model);
		expect(leaf?.session?.thinkingLevel).toBe("high");
		// Seven model turns: each delegating parent gets a receipt and a later completion.
		// Descendant usage is billed exactly once, not also on the receipt.
		expect(result.usage?.totalTokens).toBe(21);
		expect(result.usage?.cost.total).toBeCloseTo(0.21);
		expect(Object.keys(result).sort()).toEqual([
			"error",
			"id",
			"output",
			"status",
			"usage",
		]);
	});

	test("an idle headless parent accepts a continuation before its descendant completes and bills it in the same run", async () => {
		const tree = runtime();
		const gate = deferred();
		let leafStarted = false;
		const paused = stream(async (context, options) => {
			if (lastText(context) === "nest:0") {
				leafStarted = true;
				await Promise.race([gate.promise, waiting(options?.signal)]);
			}
			return hierarchyStream(model, context, options).result();
		});
		const started = tree.start(ROOT, "nest:1", await spawnContext(paused));
		let completed = false;
		void started.result.then(() => {
			completed = true;
		});
		let sent: Promise<void> | undefined;
		try {
			await until(() => leafStarted && Boolean(tree.get("1")?.session?.isIdle));
			const node = tree.get("1");
			if (!node) throw new Error("Missing parent");
			const tools = [...node.liveTools.keys()];
			let accepted = false;
			sent = tree.send("1", "live continuation").then(() => {
				accepted = true;
			});
			await until(() => accepted, 1000);
			expect(completed).toBe(false);
			expect(node?.status).toBe("running");
			expect(node?.session?.getLastAssistantText()).toBe("live continuation");
			expect([...node.liveTools.keys()]).toEqual(tools);
			gate.resolve();
			expect(await started.result).toMatchObject({
				status: "done",
				output: "hello",
				usage: { totalTokens: 15 },
			});
			expect(node?.session?.getSessionStats().tokens.total).toBe(15);
		} finally {
			gate.resolve();
			await sent;
		}
	});

	test("runtime cancellation remains attached while an idle parent drains a child", async () => {
		const tree = runtime();
		let leafStarted = false;
		const paused = stream((context, options) => {
			if (lastText(context) === "nest:0") {
				leafStarted = true;
				return waiting(options?.signal);
			}
			return hierarchyStream(model, context, options).result();
		});
		const controller = new AbortController();
		const result = tree.start(
			ROOT,
			"nest:1",
			await spawnContext(paused),
			controller.signal,
		).result;
		await until(() => leafStarted && Boolean(tree.get("1")?.session?.isIdle));
		controller.abort();
		expect((await result).status).toBe("aborted");
		expect(tree.get("1.1")?.status).toBe("aborted");
		// Suppressed notifications must not discard the child's billed work.
		expect((await result).usage.totalTokens).toBe(9);
	});

	test("parallel siblings receive unique IDs and independent transcripts", async () => {
		const tree = runtime();
		const context = await spawnContext();
		const results = await Promise.all(
			["left", "right"].map(
				(instructions) => tree.start(ROOT, instructions, context).result,
			),
		);
		expect(results.map((result) => result.id)).toEqual(["1", "2"]);
		expect(results.map((result) => result.output)).toEqual(["left", "right"]);
		expect(tree.get("1")?.session?.sessionId).not.toBe(
			tree.get("2")?.session?.sessionId,
		);
		expect(
			JSON.stringify(
				tree
					.get("1")
					?.session?.messages.filter((message) => message.role !== "system"),
			),
		).not.toContain("right");
	});
});

describe("task results", () => {
	test("failed headless completion delivery is reported, billed once, and cleans its unused output file", async () => {
		const tree = runtime();
		const gate = deferred();
		let leafStarted = false;
		let path: string | undefined;
		const paused = stream(async (context, options) => {
			if (lastText(context) === "nest:0") {
				leafStarted = true;
				await Promise.race([gate.promise, waiting(options?.signal)]);
				return response("large output\n".repeat(3000));
			}
			return hierarchyStream(model, context, options).result();
		});
		const result = tree.start(
			ROOT,
			"nest:1",
			await spawnContext(paused),
		).result;
		try {
			await until(() => leafStarted && Boolean(tree.get("1")?.session?.isIdle));
			const parent = tree.get("1")?.session;
			if (!parent) throw new Error("Missing parent");
			parent.sendCustomMessage = async (message) => {
				path = (message.details as SubagentCompletionDetails).fullOutputPath;
				throw new Error("completion sender failed");
			};
			gate.resolve();
			expect(await result).toMatchObject({
				status: "error",
				error: "completion sender failed",
				usage: { totalTokens: 9 },
			});
			expect(parent.getSessionStats().tokens.total).toBe(9);
			if (!path) throw new Error("Missing output file");
			await expect(readFile(path)).rejects.toThrow();
		} finally {
			gate.resolve();
			if (path) await rm(dirname(path), { recursive: true, force: true });
		}
	});

	test("subtree cancellation discards output files belonging to abandoned queued completions", async () => {
		const tree = runtime();
		const child = deferred();
		const parent = deferred();
		let childRunning = false;
		let parentRunning = false;
		let path: string | undefined;
		const paused = stream(async (context, options) => {
			if (lastText(context) === "nest:0") {
				childRunning = true;
				await Promise.race([child.promise, waiting(options?.signal)]);
				return response("large output\n".repeat(3000));
			}
			if (lastText(context) === "busy parent") {
				parentRunning = true;
				await Promise.race([parent.promise, waiting(options?.signal)]);
			}
			return hierarchyStream(model, context, options).result();
		});
		const result = tree.start(
			ROOT,
			"nest:1",
			await spawnContext(paused),
		).result;
		let sent: Promise<void> | undefined;
		try {
			await until(
				() => childRunning && Boolean(tree.get("1")?.session?.isIdle),
			);
			sent = tree.send("1", "busy parent");
			await until(() => parentRunning);
			child.resolve();
			const session = tree.get("1")?.session;
			await until(() => {
				const message = session?.agent
					.peekQueuedMessages()
					.find((message) => message.role === "custom");
				if (message?.role !== "custom") return false;
				path = (message.details as SubagentCompletionDetails).fullOutputPath;
				return Boolean(path);
			});
			tree.abort("1");
			expect(await result).toMatchObject({
				status: "aborted",
				usage: { totalTokens: 12 },
			});
			await sent;
			if (!path) throw new Error("Missing queued output file");
			await expect(readFile(path)).rejects.toThrow();
			expect(session?.agent.peekQueuedMessages()).toHaveLength(0);
		} finally {
			child.resolve();
			parent.resolve();
			await sent;
			if (path) await rm(dirname(path), { recursive: true, force: true });
		}
	});

	test("joins all final text blocks, surfaces failures, and returns full output without presentation hints", async () => {
		const tree = runtime();
		const combined = await tree.start(
			ROOT,
			"blocks",
			await spawnContext(
				stream(() =>
					response("", {
						content: [
							{ type: "text", text: "one" },
							{ type: "text", text: "two" },
						],
					}),
				),
			),
		).result;
		expect(combined.output).toBe("one\ntwo");
		const failure = await tree.start(
			ROOT,
			"fail",
			await spawnContext(
				stream(() =>
					response("", {
						stopReason: "error",
						errorMessage: "provider unavailable",
					}),
				),
			),
		).result;
		expect(failure.status).toBe("error");
		expect(failure.output).toBe("provider unavailable");
		const huge = "日本語".repeat(20_000);
		const large = await tree.start(
			ROOT,
			"huge",
			await spawnContext(stream(() => response(huge))),
		).result;
		expect(large.output).toBe(huge);
	});
});

describe("interaction and cleanup", () => {
	test("a completed descendant can be messaged in its own conversation without reporting to parent", async () => {
		const tree = runtime();
		const result = await tree.start(ROOT, "nest:1", await spawnContext())
			.result;
		const parentMessages = JSON.stringify(tree.get("1")?.session?.messages);
		await tree.send("1.1", "new instructions");
		expect(
			tree
				.get("1.1")
				?.session?.messages.filter((message) => message.role === "user"),
		).toHaveLength(2);
		expect(JSON.stringify(tree.get("1")?.session?.messages)).toBe(
			parentMessages,
		);
		expect(result.output).toBe("hello");
	});

	test("messages steer a running child and are included in its final result", async () => {
		const tree = runtime();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const paused = stream(async (context) => {
			if (calls++ === 0) await gate;
			return response(lastText(context));
		});
		const result = tree.start(
			ROOT,
			"original",
			await spawnContext(paused),
		).result;
		await until(() => calls === 1);
		await tree.send("1", "replacement");
		release?.();
		expect((await result).output).toBe("replacement");
		expect(calls).toBe(2);
	});

	test("steering at settlement is drained before reporting a final result", async () => {
		const tree = runtime();
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
		const result = tree.start(ROOT, "initial", await spawnContext()).result;
		expect((await result).output).toBe("late steering");
		expect(tree.get("1")?.session?.pendingMessageCount).toBe(0);
	});

	test("UI cancellation before a prompt is active is not lost", async () => {
		const tree = runtime();
		let stopped = false;
		const unsubscribe = tree.subscribe(() => {
			if (!stopped && tree.get("1")) {
				stopped = true;
				tree.abort("1");
			}
		});
		const result = await tree.start(ROOT, "hello", await spawnContext()).result;
		expect(result.status).toBe("aborted");
		expect(tree.get("1")?.status).toBe("aborted");
		unsubscribe();
	});

	test("parent cancellation aborts all descendants, not independent siblings", async () => {
		const tree = runtime();
		const paused = stream((context, options) => {
			if (lastText(context) === "parent")
				return toolCall("subagent", { instructions: "waiting" });
			return waiting(options?.signal);
		});
		const controller = new AbortController();
		const parent = tree.start(
			ROOT,
			"parent",
			await spawnContext(paused),
			controller.signal,
		).result;
		const sibling = tree.start(
			ROOT,
			"sibling",
			await spawnContext(paused),
		).result;
		await until(() => Boolean(tree.get("1.1")?.session?.isStreaming));
		controller.abort();
		expect((await parent).status).toBe("aborted");
		expect(tree.get("1")?.status).toBe("aborted");
		expect(tree.get("1.1")?.status).toBe("aborted");
		expect(tree.get("2")?.status).toBe("running");
		tree.abort("2");
		await sibling;
	});

	test("UI subtree abort covers restarted descendants and supports restarting after stop", async () => {
		const tree = runtime();
		await tree.start(ROOT, "nest:1", await spawnContext()).result;
		const leaf = tree.get("1.1");
		if (!leaf?.session) throw new Error("Missing leaf");
		leaf.session.agent.streamFunction = stream((_context, options) =>
			waiting(options?.signal),
		);
		const restarted = tree.send("1.1", "wait");
		await until(() => Boolean(leaf.session?.isStreaming));
		tree.abort("1");
		await restarted;
		expect(leaf.status).toBe("aborted");
		leaf.session.agent.streamFunction = hierarchyStream;
		await tree.send("1.1", "say hello");
		expect(leaf.status).toBe("done");
	});

	test("shutdown requested by an initial lifecycle callback waits for the whole run", async () => {
		const tree = runtime();
		let shutdown: Promise<void> | undefined;
		let node: ReturnType<Subagents["get"]>;
		tree.subscribe(() => {
			if (!tree.closed && tree.get("1")) {
				node = tree.get("1");
				shutdown = tree.dispose();
			}
		});
		const result = tree.start(ROOT, "hello", await spawnContext()).result;
		await shutdown;
		expect(node?.session?.isStreaming ?? false).toBe(false);
		expect((await result).status).toBe("aborted");
		expect(tree.tree()).toHaveLength(0);
	});
});
