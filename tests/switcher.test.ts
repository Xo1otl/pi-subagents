import { afterEach, expect, mock, test } from "bun:test";
import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	matchesKey,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createSubagents, ROOT, type Subagents } from "../runtime.ts";
import { createSubagentSwitcher, type SubagentSwitcher } from "../switcher.ts";
import { response, spawnContext, stream, until, waiting } from "./fixtures.ts";

const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };
const keybindings: Pick<KeybindingsManager, "matches"> = {
	matches(data, action) {
		if (action === "app.interrupt") return matchesKey(data, "escape");
		if (action === "tui.input.submit") return matchesKey(data, "enter");
		if (action === "tui.editor.pageUp") return matchesKey(data, "pageUp");
		if (action === "tui.editor.pageDown") return matchesKey(data, "pageDown");
		return false;
	},
};
const trees: Subagents[] = [];
const switchers: SubagentSwitcher[] = [];
afterEach(async () => {
	for (const switcher of switchers.splice(0)) switcher.dispose();
	await Promise.all(trees.splice(0).map((tree) => tree.dispose()));
});

async function setup({ empty = false }: { empty?: boolean } = {}) {
	const tree = createSubagents();
	trees.push(tree);
	if (!empty) {
		await tree.spawn(ROOT, "nest:1", await spawnContext());
		await tree.spawn(ROOT, "other", await spawnContext());
	}
	const tui = { requestRender: mock(() => {}), terminal: { rows: 24 } };
	const done = mock(() => {});
	const switcher = createSubagentSwitcher({
		runtime: tree,
		tui,
		theme,
		keybindings,
		onClose: done,
	});
	switchers.push(switcher);
	return { tree, tui, switcher, done };
}

test("selects the first arriving child before rendering or handling submit", async () => {
	const { tree, switcher } = await setup({ empty: true });
	expect(switcher.render(80).join("\n")).toContain("No subagents yet.");
	await tree.spawn(ROOT, "hello", await spawnContext());
	switcher.handleInput("selected without rendering");
	switcher.handleInput("\r");
	await until(() => tree.get("1")?.status === "done");
	expect(JSON.stringify(tree.get("1")?.session?.messages)).toContain(
		"selected without rendering",
	);
});

test("renders extension-injected messages from the child's raw transcript", async () => {
	const { tree, switcher } = await setup();
	await tree.get("1")?.session?.sendCustomMessage({
		customType: "extension-note",
		content: "EXTENSION_MESSAGE_MARKER",
		display: true,
	});
	expect(switcher.render(80).join("\n")).toContain("EXTENSION_MESSAGE_MARKER");
});

test("rendering and resizing do not change interaction state or notify the host", async () => {
	const { tree, switcher, tui } = await setup();
	await tree.send(
		"1",
		Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
	);
	switcher.handleInput("unsent draft");
	switcher.render(80);
	switcher.handleInput("\x1b[5~");
	switcher.handleInput("\x1b[5~");
	const expected = switcher.render(80);
	const revision = tree.get("1")?.revision;
	tui.requestRender.mockClear();
	tui.terminal.rows = 100;
	switcher.render(80);
	tui.terminal.rows = 24;
	expect(switcher.render(80)).toEqual(expected);
	switcher.invalidate();
	expect(switcher.render(80)).toEqual(expected);
	expect(tree.get("1")?.revision).toBe(revision);
	expect(tui.requestRender).not.toHaveBeenCalled();
});

test("finishing unsubscribes immediately and cleanup is idempotent", async () => {
	const { tree, switcher, tui, done } = await setup();
	const { handleInput, dispose } = switcher;
	handleInput("\x1b");
	tui.requestRender.mockClear();
	await tree.send("1", "continues after closing the overlay");
	expect(tui.requestRender).not.toHaveBeenCalled();
	dispose();
	dispose();
	handleInput("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
});

test.each(["dispose", "switch"])(
	"ignores late send failures after %s",
	async (action) => {
		const { tree, switcher, tui } = await setup();
		let reject = (_error: Error) => {};
		const pending = new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
		tree.send = () => pending;
		switcher.handleInput("message");
		switcher.handleInput("\r");
		if (action === "dispose") switcher.dispose();
		else switcher.handleInput("\t");
		tui.requestRender.mockClear();
		reject(new Error("late send failure"));
		await pending.catch(() => {});
		expect(tui.requestRender).not.toHaveBeenCalled();
		expect(switcher.render(80).join("\n")).not.toContain("late send failure");
	},
);

test("cycles through all descendants, preserves drafts, sends to the selected child and returns to root", async () => {
	const { tree, switcher, done } = await setup();
	switcher.handleInput("draft");
	switcher.handleInput("\t");
	expect(switcher.render(100)[0]).toContain("1.1");
	switcher.handleInput("message the leaf");
	switcher.handleInput("\r");
	await until(() => tree.get("1.1")?.status === "done");
	expect(JSON.stringify(tree.get("1.1")?.session?.messages)).toContain(
		"message the leaf",
	);
	expect(JSON.stringify(tree.get("1")?.session?.messages)).not.toContain(
		"message the leaf",
	);
	switcher.handleInput("\t");
	expect(switcher.render(100)[0]).toContain("2");
	switcher.handleInput("\t");
	expect(stripTerminalSequences(switcher.render(100).join("\n"))).toContain(
		"draft",
	);
	switcher.handleInput("\x1b[Z");
	expect(switcher.render(100)[0]).toContain("2");
	switcher.handleInput("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
});

test("renders within narrow widths, tiny heights and wide Unicode, and propagates IME focus", async () => {
	const { tree, switcher, tui } = await setup();
	await tree.send("1", "日本語🙂".repeat(50));
	switcher.focused = true;
	switcher.handleInput("界🙂draft");
	for (const width of [1, 5, 20, 80]) {
		for (const rows of [2, 5, 10, 24]) {
			tui.terminal.rows = rows;
			switcher.invalidate();
			const lines = switcher.render(width);
			expect(lines.length).toBeLessThanOrEqual(
				Math.max(1, Math.floor(rows * 0.9)),
			);
			for (const line of lines)
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
	tui.terminal.rows = 24;
	expect(switcher.render(80).join("\n")).toContain(CURSOR_MARKER);
	switcher.focused = false;
	expect(switcher.render(80).join("\n")).not.toContain(CURSOR_MARKER);
});

test("scrolls full output, strips terminal control sequences, and updates only its UI", async () => {
	const { tree, switcher, tui } = await setup();
	const node = tree.get("1");
	if (!node?.session) throw new Error("Missing node");
	node.session.agent.streamFunction = stream(() =>
		response(
			"\x1b]2;BAD-TITLE\x07\x1b[31mfirst\n" +
				Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
		),
	);
	await tree.send("1", "many lines");
	expect(tui.requestRender).toHaveBeenCalled();
	expect(switcher.render(80).join("\n")).toContain("line 59");
	switcher.handleInput("\x1b[5~");
	expect(switcher.render(80).join("\n")).not.toContain("line 59");
	for (let i = 0; i < 10; i++) switcher.handleInput("\x1b[5~");
	expect(switcher.render(80).join("\n")).not.toContain("BAD-TITLE");
	switcher.handleInput("\x1b[6~");
	switcher.handleInput("\x1b[1;5F");
	expect(switcher.render(80).join("\n")).toContain("line 59");
});

test("Ctrl+C stops the selected subtree and active shutdown finishes the overlay only once", async () => {
	const { tree, switcher, done } = await setup();
	const context = await spawnContext(
		stream((_context, options) => waiting(options?.signal)),
	);
	const child = tree.spawn("1.1", "wait", context);
	await until(() => Boolean(tree.get("1.1.1")?.session?.isStreaming));
	switcher.handleInput("\x03");
	await child;
	expect(tree.get("1.1.1")?.status).toBe("aborted");
	const siblings = Promise.all([
		tree.spawn(ROOT, "wait", context),
		tree.spawn(ROOT, "wait", context),
	]);
	await until(() => Boolean(tree.get("4")?.session?.isStreaming));
	await tree.dispose();
	await siblings;
	switcher.handleInput("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
});

test("closing the runtime finishes the overlay; disposal removes the subscription", async () => {
	const { tree, switcher, done, tui } = await setup();
	switcher.dispose();
	tui.requestRender.mockClear();
	await tree.send("1", "hello");
	expect(tui.requestRender).not.toHaveBeenCalled();
	const open = createSubagentSwitcher({
		runtime: tree,
		tui,
		theme,
		keybindings,
		onClose: done,
		initialId: "1.1",
	});
	switchers.push(open);
	await tree.dispose();
	expect(done).toHaveBeenCalledTimes(1);
});
