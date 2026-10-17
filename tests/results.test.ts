import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { subagentCompletionMessage } from "../agent/completions.ts";
import { subagentReceipt } from "../agent/protocol.ts";
import type { SubagentResult } from "../runtime/index.ts";
import {
	renderSubagentCall,
	renderSubagentResult,
} from "../ui/tool-renderers.ts";
import { response } from "./fixtures.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

function run(output: string): SubagentResult {
	return {
		id: "1",
		status: "done",
		output,
		usage: response("").usage,
	};
}

test("running receipts contain only the agent ID and status", () => {
	const receipt = { id: "1", status: "running" as const };
	expect(subagentReceipt({ id: "1" })).toEqual({
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		structuredContent: receipt,
	});
});

test("completions omit redundant hierarchy fields", async () => {
	const result = run("task output");
	const message = await subagentCompletionMessage(result);
	expect(message.content).toEqual([
		{ type: "text", text: "Subagent 1 done." },
		{ type: "text", text: "task output" },
	]);
	expect(message.details).toEqual({
		id: "1",
		status: "done",
		error: undefined,
		usage: result.usage,
	});
});

test("tool call renderers tolerate unknown or partial arguments", () => {
	const theme = { fg: (_color: string, text: string) => text };
	for (const args of [undefined, null, {}, "invalid"])
		expect(
			renderSubagentCall(args, theme)
				.render(80)
				.map((line) => line.trimEnd()),
		).toEqual(["Subagent …"]);
});

test.each([
	"日本語".repeat(20_000),
	Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n"),
])(
	"truncated output is retrievable through a file, not a human-only command",
	async (output) => {
		const result = run(output);
		const message = await subagentCompletionMessage(result);
		const path = message.details.fullOutputPath;
		if (!path) throw new Error("Missing full output file");
		directories.push(dirname(path));
		expect(isAbsolute(path)).toBe(true);
		expect(await readFile(path, "utf8")).toBe(output);
		const text = message.content.at(-1);
		expect(text?.type).toBe("text");
		if (text?.type !== "text") throw new Error("Missing completion text");
		expect(text.text).toContain("Output truncated.");
		expect(text.text).toContain(path);
		expect(text.text).not.toContain("/subagents");
		expect(text.text).not.toContain("Ctrl+Shift+A");
		expect(text.text).not.toContain("�");
	},
);

test("renders partial calls and background receipts with switcher guidance", () => {
	const theme = { fg: (_color: string, text: string) => text };
	const render = (
		result: Parameters<typeof renderSubagentResult>[0],
		isPartial: boolean,
	) =>
		renderSubagentResult(result, { expanded: false, isPartial }, theme)
			.render(80)
			.map((line) => line.trimEnd());
	expect(render({ content: [], details: {} }, true)).toEqual(["Delegating…"]);
	expect(render(subagentReceipt({ id: "2" }), false)).toEqual([
		"Subagent 2 · running in background",
		"/subagents 2 · view conversation",
	]);
});

test("a failed output-file write still produces bounded completion content and preserves usage", async () => {
	const previous = process.env.TMPDIR;
	let message: Awaited<ReturnType<typeof subagentCompletionMessage>>;
	try {
		process.env.TMPDIR = join(
			tmpdir(),
			`pi-subagents-missing-${crypto.randomUUID()}`,
			"missing",
		);
		message = await subagentCompletionMessage(
			run("large output\n".repeat(3000)),
		);
	} finally {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
	}
	const text = message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
	expect(text).toContain("Could not save full output");
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
	expect(message.details.usage.totalTokens).toBe(3);
	expect(message.details.fullOutputPath).toBeUndefined();
});

test("continued runs with the same agent ID cannot overwrite earlier output files", async () => {
	const first = await subagentCompletionMessage(run("first\n".repeat(2100)));
	const second = await subagentCompletionMessage(run("second\n".repeat(2100)));
	const firstPath = first.details.fullOutputPath;
	const secondPath = second.details.fullOutputPath;
	if (!firstPath || !secondPath) throw new Error("Missing full output file");
	directories.push(dirname(firstPath), dirname(secondPath));
	expect(firstPath).not.toBe(secondPath);
	expect(await readFile(firstPath, "utf8")).toBe("first\n".repeat(2100));
	expect(await readFile(secondPath, "utf8")).toBe("second\n".repeat(2100));
});
