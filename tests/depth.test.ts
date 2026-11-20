import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSubagentRuntime } from "../agent/index.ts";
import { maxDepthSetting } from "../agent/settings.ts";
import { createSubagents, ROOT, type Subagents } from "../runtime/index.ts";
import { onCleanup, rootSession, spawnContext } from "./fixtures.ts";

function limitedRuntime(maxDepth?: number): Subagents {
	const runtime = createSubagentRuntime({ maxDepth });
	onCleanup(() => runtime.dispose());
	return runtime;
}

const tools = (runtime: Subagents, id: string) =>
	runtime.get(id)?.session?.getActiveToolNames() ?? [];

test("depth is unlimited by default", async () => {
	const tree = limitedRuntime();
	expect(tree.maxDepth).toBe(Number.POSITIVE_INFINITY);
	expect(
		await tree.start(ROOT, "nest:3", await spawnContext()).result,
	).toMatchObject({ status: "done", output: "hello" });
	expect(tools(tree, "1.1.1.1")).toContain("subagent");
});

test("subagents at the maximum depth get no subagent tool and cannot spawn", async () => {
	const tree = limitedRuntime(2);
	const context = await spawnContext();
	expect(await tree.start(ROOT, "nest:1", context).result).toMatchObject({
		status: "done",
		output: "hello",
	});
	expect(tools(tree, "1")).toContain("subagent");
	expect(tools(tree, "1.1")).not.toContain("subagent");
	expect(tools(tree, "1.1")).toContain("report_to_parent");
	expect([ROOT, "1", "1.1"].map((id) => tree.canSpawn(id))).toEqual([
		true,
		true,
		false,
	]);
	expect(() => tree.start("1.1", "nest:0", context)).toThrow(
		"Subagent depth limit reached: 1.1 is at the maximum depth (2).",
	);
	expect(tree.tree().map(({ id }) => id)).toEqual(["1", "1.1"]);
});

test("the runtime rejects invalid maximum depths", () => {
	for (const maxDepth of [0, -1, 1.5, Number.NaN])
		expect(() =>
			createSubagents({
				createSession: async () => {},
				remindSession: async () => {},
				disposeSession: async () => {},
				reportOf: () => undefined,
				maxDepth,
			}),
		).toThrow(RangeError);
});

test("the root reads the maximum depth from settings", async () => {
	const { tree, execute } = await rootSession({
		settings: { subagents: { maxDepth: 1 } },
	});
	expect(tree.maxDepth).toBe(1);
	await execute("call", { instructions: "say hello" });
	await tree.settled(ROOT);
	expect(tree.get("1")?.status).toBe("done");
	expect(tools(tree, "1")).not.toContain("subagent");
});

test("an invalid setting leaves depth unlimited", async () => {
	const { tree } = await rootSession({
		settings: { subagents: { maxDepth: "2" } },
	});
	expect(tree.maxDepth).toBe(Number.POSITIVE_INFINITY);
});

test("maxDepthSetting validates subagents.maxDepth", () => {
	expect(maxDepthSetting({})).toBeUndefined();
	expect(maxDepthSetting({ subagents: {} })).toBeUndefined();
	expect(maxDepthSetting({ subagents: { maxDepth: null } })).toBeUndefined();
	expect(maxDepthSetting({ subagents: { maxDepth: 3 } })).toBe(3);
	for (const maxDepth of [0, 2.5, "2", true])
		expect(() => maxDepthSetting({ subagents: { maxDepth } })).toThrow(
			"Setting subagents.maxDepth must be a positive integer",
		);
});

test("an installed copy of the extension also hides the tool at the maximum depth", async () => {
	const tree = limitedRuntime(1);
	const context = await spawnContext();
	await writeFile(
		join(context.agentDir, "extensions", "pi-subagents.js"),
		`export { default } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};`,
	);
	expect(await tree.start(ROOT, "say hello", context).result).toMatchObject({
		status: "done",
	});
	expect(tools(tree, "1")).not.toContain("subagent");
	expect(tools(tree, "1")).toContain("report_to_parent");
});
