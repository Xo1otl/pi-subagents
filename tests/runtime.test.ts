import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSubagentRuntime } from "../agent/index.ts";
import type { SubagentCompletionDetails } from "../agent/protocol.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	blockingTool,
	deferred,
	fakeMonitor,
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

	test("stopping an idle parent that drains a child stops both and keeps billed work", async () => {
		const tree = runtime();
		let leafStarted = false;
		const paused = stream((context, options) => {
			if (lastText(context) === "nest:0") {
				leafStarted = true;
				return waiting(options?.signal);
			}
			return hierarchyStream(model, context, options).result();
		});
		const result = tree.start(
			ROOT,
			"nest:1",
			await spawnContext(paused),
		).result;
		await until(() => leafStarted && Boolean(tree.get("1")?.session?.isIdle));
		tree.abort("1");
		expect((await result).status).toBe("aborted");
		expect(tree.get("1.1")?.status).toBe("aborted");
		// Suppressed notifications must not discard the child's billed work.
		expect((await result).usage.totalTokens).toBe(9);
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

	test("joins all final text blocks and returns full output without presentation hints", async () => {
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

	test("input sent during a long-running tool stays queued and visible, then steers", async () => {
		const tree = runtime();
		const context = await spawnContext(
			stream((context) =>
				lastText(context) === "monitor"
					? toolCall("blocking", {})
					: response(lastText(context)),
			),
		);
		const release = await blockingTool(context);
		const result = tree.start(ROOT, "monitor", context).result;
		const node = tree.get("1");
		expect(node?.queuedInput).toEqual([]);
		await until(() =>
			[...(node?.liveTools.values() ?? [])].some(
				(tool) => tool.status === "running",
			),
		);
		const sent = tree.send("1", "are you there?");
		expect(node?.queuedInput).toEqual(["are you there?"]);
		await sent;
		expect(node?.queuedInput).toEqual(["are you there?"]);
		release.resolve();
		expect((await result).output).toBe("are you there?");
		expect(node?.queuedInput).toEqual([]);
	});

	test("stopping returns sent input that never reached the agent, not its task", async () => {
		const tree = runtime();
		const context = await spawnContext(
			stream((context) =>
				lastText(context) === "monitor"
					? toolCall("blocking", {})
					: response(lastText(context)),
			),
		);
		await blockingTool(context);
		const early = tree.start(ROOT, "monitor", context);
		// Waits for session initialization, before pi's own queue exists.
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
		await until(() =>
			[...(node?.liveTools.values() ?? [])].some(
				(tool) => tool.status === "running",
			),
		);
		await tree.send("2", "first");
		await tree.send("2", "second");
		expect(tree.abort("2")).toEqual(new Map([["2", ["first", "second"]]]));
		expect(node?.queuedInput).toEqual([]);
		expect((await steered.result).status).toBe("aborted");
	});

	test("input stopped inside slow input hooks is handed back without reaching the agent", async () => {
		const tree = runtime();
		const context = await spawnContext(
			stream((context) =>
				lastText(context) === "monitor"
					? toolCall("blocking", {})
					: response(lastText(context)),
			),
		);
		await blockingTool(context);
		const hook = deferred();
		const entered = deferred();
		const key = Symbol.for(`pi-subagents.input.${crypto.randomUUID()}`);
		Reflect.set(globalThis, key, { hook: hook.promise, entered });
		try {
			if (!context.agentDir) throw new Error("Missing agent directory");
			await mkdir(join(context.agentDir, "extensions"), { recursive: true });
			await writeFile(
				join(context.agentDir, "extensions", "input.js"),
				`export default function(pi) {
					pi.on("input", async (event) => {
						if (event.text !== "in flight") return;
						const shared = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})];
						shared.entered.resolve();
						await shared.hook;
					});
				}`,
			);
			const result = tree.start(ROOT, "monitor", context).result;
			const node = tree.get("1");
			await until(() =>
				[...(node?.liveTools.values() ?? [])].some(
					(tool) => tool.status === "running",
				),
			);
			const sent = tree.send("1", "in flight");
			await entered.promise;
			expect(tree.abort("1")).toEqual(new Map([["1", ["in flight"]]]));
			hook.resolve();
			await sent;
			expect((await result).status).toBe("aborted");
			expect(JSON.stringify(node?.session?.messages)).not.toContain(
				"in flight",
			);
			expect(node?.session?.pendingMessageCount).toBe(0);
		} finally {
			hook.resolve();
			Reflect.deleteProperty(globalThis, key);
		}
	});

	describe("background monitors", () => {
		const monitoring = () =>
			stream((context) => {
				const text = lastText(context);
				if (text === "watch build") return toolCall("monitor_start", {});
				if (text === "stop it") return toolCall("monitor_stop", {});
				if (text === "status=success") return response("build passed");
				if (context.messages.at(-1)?.role === "toolResult")
					return response(`after tool: ${text}`);
				return response(`reply: ${text}`);
			});
		async function watching(tree: Subagents) {
			const context = await spawnContext(monitoring());
			const finished = await fakeMonitor(context);
			const { result } = tree.start(ROOT, "watch build", context);
			const node = tree.get("1");
			await until(
				() =>
					Boolean(node?.session?.isIdle) &&
					Boolean(
						node?.session?.messages.some(
							(message) => message.role === "toolResult",
						),
					),
			);
			let completed = false;
			void result.then(() => {
				completed = true;
			});
			return { node, result, finished, completed: () => completed };
		}

		test("the agent converses while its monitor runs and reports after the result", async () => {
			const tree = runtime();
			const { node, result, finished, completed } = await watching(tree);
			await tree.send("1", "are you there?");
			expect(node?.session?.getLastAssistantText()).toBe(
				"reply: are you there?",
			);
			expect(node?.status).toBe("running");
			expect(completed()).toBe(false);
			finished.resolve();
			expect(await result).toMatchObject({
				status: "done",
				output: "build passed",
			});
		});

		test("monitor_stop releases the run", async () => {
			const tree = runtime();
			const { result } = await watching(tree);
			await tree.send("1", "stop it");
			expect(await result).toMatchObject({
				status: "done",
				output: "after tool: Stopped 1 monitor(s).",
			});
		});

		test("stopping the agent stops waiting for its monitor", async () => {
			const tree = runtime();
			const { result } = await watching(tree);
			tree.abort("1");
			expect((await result).status).toBe("aborted");
		});
	});

	test("parent cancellation aborts all descendants, not independent siblings", async () => {
		const tree = runtime();
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

	test("shutdown requested by lifecycle listeners waits for the whole run and is reentrant", async () => {
		const tree = runtime();
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
