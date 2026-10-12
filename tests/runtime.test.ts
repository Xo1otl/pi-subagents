import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSubagents,
	DEFAULT_MAX_DEPTH,
	parseMaxDepth,
	ROOT,
	type Subagents,
} from "../runtime.ts";
import {
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
function runtime(depth?: number): Subagents {
	const tree = createSubagents(depth);
	runtimes.push(tree);
	return tree;
}
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((tree) => tree.dispose()));
});

describe("runtime factory", () => {
	test("keeps limits, IDs, subscriptions, and shutdown local to each instance", async () => {
		const disabled = runtime(0);
		const enabled = runtime(2);
		const listener = mock(() => {});
		disabled.subscribe(listener);
		await expect(
			disabled.spawn(ROOT, "hello", await spawnContext()),
		).rejects.toThrow("max depth 0");
		expect(
			(await enabled.spawn(ROOT, "nest:1", await spawnContext())).details.id,
		).toBe("1");
		expect(listener).not.toHaveBeenCalled();
		disabled.setMaxDepth(1);
		expect(enabled.maxDepth).toBe(2);
		expect(
			(await disabled.spawn(ROOT, "hello", await spawnContext())).details.id,
		).toBe("1");
		await disabled.dispose();
		expect(enabled.closed).toBe(false);
		await enabled.send("1.1", "still available");
		expect(enabled.get("1.1")?.status).toBe("done");
	});

	test("operations do not depend on a method receiver", async () => {
		const tree = runtime();
		const { spawn, send, get, tree: nodes, setMaxDepth, abort, dispose } = tree;
		setMaxDepth(2);
		await spawn(ROOT, "hello", await spawnContext());
		await send("1", "updated");
		expect(get("1")?.status).toBe("done");
		expect(nodes()).toHaveLength(1);
		expect((await spawn(ROOT, "hello", await spawnContext())).details.id).toBe(
			"2",
		);
		abort();
		await dispose();
		expect(tree.closed).toBe(true);
	});

	test("reentrant shutdown listeners receive the same closing promise", async () => {
		const tree = runtime();
		const result = tree.spawn(
			ROOT,
			"wait",
			await spawnContext(
				stream((_context, options) => waiting(options?.signal)),
			),
		);
		await until(() => Boolean(tree.get("1")?.session?.isStreaming));
		const closings: Promise<void>[] = [];
		tree.subscribe(() => {
			if (tree.closed) closings.push(tree.dispose());
		});
		const closed = tree.dispose();
		await closed;
		expect(closings.length).toBeGreaterThan(0);
		for (const closing of closings) expect(closing).toBe(closed);
		expect((await result).isError).toBe(true);
		expect(tree.tree()).toHaveLength(0);
	});
});

describe("silent hierarchy", () => {
	test("returns the final result and keeps each conversation separate", async () => {
		const tree = runtime();
		const result = await tree.spawn(ROOT, "nest:2", await spawnContext());
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(result.details).toEqual({ id: "1", parentId: ROOT, depth: 1 });
		expect(result.isError).toBe(false);
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
		// Five model turns total: parent and middle have two, leaf has one. No double-counting.
		expect(result.usage?.totalTokens).toBe(15);
		expect(result.usage?.cost.total).toBeCloseTo(0.15);
		expect(Object.keys(result.details)).not.toContain("messages");
	});

	test("default cap permits depths 1 through 5 and rejects depth 6", async () => {
		const tree = runtime();
		expect(tree.maxDepth).toBe(DEFAULT_MAX_DEPTH);
		expect(
			(await tree.spawn(ROOT, "nest:4", await spawnContext())).isError,
		).toBe(false);
		expect(tree.tree().at(-1)?.depth).toBe(5);
		const result = await tree.spawn(ROOT, "nest:5", await spawnContext());
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("depth 6 exceeds max depth 5"),
		});
		expect(tree.tree().every((node) => node.depth <= 5)).toBe(true);
	});

	test("depth changes apply to existing descendants and 0 disables spawning", async () => {
		const tree = runtime(2);
		await tree.spawn(ROOT, "nest:1", await spawnContext());
		tree.setMaxDepth(1);
		await expect(
			tree.spawn("1.1", "say hello", await spawnContext()),
		).rejects.toThrow("depth 3 exceeds max depth 1");
		tree.setMaxDepth(3);
		expect(
			(await tree.spawn("1.1", "say hello", await spawnContext())).details
				.depth,
		).toBe(3);
		tree.setMaxDepth(0);
		await expect(
			tree.spawn(ROOT, "say hello", await spawnContext()),
		).rejects.toThrow("depth 1 exceeds max depth 0");
	});

	test("validates depth and instructions without creating nodes", async () => {
		for (const value of [
			"",
			"-1",
			"1.5",
			"Infinity",
			"NaN",
			"9007199254740992",
			"five",
		]) {
			expect(() => parseMaxDepth(value)).toThrow();
		}
		expect(parseMaxDepth("0")).toBe(0);
		expect(parseMaxDepth("5")).toBe(5);
		const tree = runtime();
		expect(() => tree.setMaxDepth(-1)).toThrow();
		await expect(tree.spawn(ROOT, "  ", await spawnContext())).rejects.toThrow(
			"must not be empty",
		);
		await expect(
			tree.spawn("missing", "hello", await spawnContext()),
		).rejects.toThrow("Unknown parent");
		const controller = new AbortController();
		controller.abort();
		await expect(
			tree.spawn(ROOT, "hello", await spawnContext(), controller.signal),
		).rejects.toThrow();
		expect(tree.tree()).toHaveLength(0);
	});

	test("parallel siblings receive unique IDs and independent transcripts", async () => {
		const tree = runtime();
		const context = await spawnContext();
		const results = await Promise.all(
			["left", "right"].map((instructions) =>
				tree.spawn(ROOT, instructions, context),
			),
		);
		expect(results.map((result) => result.details.id)).toEqual(["1", "2"]);
		expect(results.map((result) => result.content[0])).toEqual([
			{ type: "text", text: "left" },
			{ type: "text", text: "right" },
		]);
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
	test("completes a file-editing task through pi tools", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-subagents-test-"));
		const path = join(directory, "result.txt");
		try {
			const tree = runtime();
			let calls = 0;
			const toolsStream = stream((context) => {
				if (calls++ === 0) return toolCall("write", { path, content: "hello" });
				if (calls === 2)
					return toolCall("edit", { path, oldText: "hello", newText: "world" });
				return response(lastText(context));
			});
			expect(
				(
					await tree.spawn(
						ROOT,
						"edit the file",
						await spawnContext(toolsStream),
					)
				).isError,
			).toBe(false);
			expect(await readFile(path, "utf8")).toBe("world");
			const node = tree.get("1");
			expect(node?.session?.state.tools.map((tool) => tool.name)).toEqual(
				expect.arrayContaining(["read", "bash", "edit", "write", "subagent"]),
			);
			const bash = node?.session?.state.tools.find(
				(tool) => tool.name === "bash",
			);
			const output = await bash?.execute("shell", {
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Shell variable expansion, not JavaScript.
				command: 'printf "%s" "${PI_SESSION_ID-unset}"',
			});
			expect(output?.content[0]).toEqual({
				type: "text",
				text: node?.session?.sessionId ?? "missing",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("joins all final text blocks, surfaces failures, and keeps full long output for UI", async () => {
		const tree = runtime();
		const combined = await tree.spawn(
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
		);
		expect(combined.content).toEqual([{ type: "text", text: "one\ntwo" }]);
		const failure = await tree.spawn(
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
		);
		expect(failure.isError).toBe(true);
		expect(failure.content).toEqual([
			{ type: "text", text: "provider unavailable" },
		]);
		const huge = "日本語".repeat(20_000);
		const large = await tree.spawn(
			ROOT,
			"huge",
			await spawnContext(stream(() => response(huge))),
		);
		expect(JSON.stringify(large.content)).toContain(
			"Full output: /subagents 3",
		);
		const final = tree.get("3")?.session?.messages.at(-1);
		expect(final?.role === "assistant" && final.content).toEqual([
			{ type: "text", text: huge },
		]);
	});
});

describe("interaction and cleanup", () => {
	test("a completed descendant can be messaged in its own conversation without reporting to parent", async () => {
		const tree = runtime();
		const result = await tree.spawn(ROOT, "nest:1", await spawnContext());
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
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
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
		const result = tree.spawn(ROOT, "original", await spawnContext(paused));
		await until(() => calls === 1);
		await tree.send("1", "replacement");
		release?.();
		expect((await result).content).toEqual([
			{ type: "text", text: "replacement" },
		]);
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
		const result = tree.spawn(ROOT, "initial", await spawnContext());
		expect((await result).content).toEqual([
			{ type: "text", text: "late steering" },
		]);
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
		const result = await tree.spawn(ROOT, "hello", await spawnContext());
		expect(result.isError).toBe(true);
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
		const parent = tree.spawn(
			ROOT,
			"parent",
			await spawnContext(paused),
			controller.signal,
		);
		const sibling = tree.spawn(ROOT, "sibling", await spawnContext(paused));
		await until(() => Boolean(tree.get("1.1")?.session?.isStreaming));
		controller.abort();
		expect((await parent).isError).toBe(true);
		expect(tree.get("1")?.status).toBe("aborted");
		expect(tree.get("1.1")?.status).toBe("aborted");
		expect(tree.get("2")?.status).toBe("running");
		tree.abort("2");
		await sibling;
	});

	test("UI subtree abort covers restarted descendants and supports restarting after stop", async () => {
		const tree = runtime();
		await tree.spawn(ROOT, "nest:1", await spawnContext());
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
		const result = tree.spawn(ROOT, "hello", await spawnContext());
		await shutdown;
		expect(node?.session?.isStreaming ?? false).toBe(false);
		expect((await result).isError).toBe(true);
		expect(tree.tree()).toHaveLength(0);
	});

	test("shutdown aborts work, closes once, removes listeners and rejects new work", async () => {
		const tree = runtime();
		const result = tree.spawn(
			ROOT,
			"wait",
			await spawnContext(
				stream((_context, options) => waiting(options?.signal)),
			),
		);
		await until(() => Boolean(tree.get("1")?.session?.isStreaming));
		const closed = tree.dispose();
		expect(tree.dispose()).toBe(closed);
		await closed;
		await result;
		expect(tree.closed).toBe(true);
		expect(tree.tree()).toHaveLength(0);
		await expect(
			tree.spawn(ROOT, "hello", await spawnContext()),
		).rejects.toThrow("shut down");
		await expect(tree.send("1", "hello")).rejects.toThrow("shut down");
	});
});
