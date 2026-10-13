import { afterEach, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	matchesKey,
	stripTerminalSequences,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { createSubagentRuntime } from "../agent/index.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	createSubagentSwitcher,
	type SubagentSwitcher,
} from "../ui/switcher.ts";
import { response, spawnContext, stream, toolCall, until } from "./fixtures.ts";

const theme = { fg: (_color: string, text: string) => text };
const keys: Pick<KeybindingsManager, "matches"> = {
	matches(data, action) {
		if (action === "app.interrupt") return matchesKey(data, "escape");
		if (action === "tui.input.submit") return matchesKey(data, "enter");
		if (action === "tui.altScreen.pageUp") return matchesKey(data, "pageUp");
		if (action === "tui.altScreen.pageDown")
			return matchesKey(data, "pageDown");
		if (action === "tui.altScreen.top") return matchesKey(data, "ctrl+home");
		if (action === "tui.altScreen.bottom") return matchesKey(data, "ctrl+end");
		if (action === "app.tools.expand") return matchesKey(data, "ctrl+o");
		if (action === "app.thinking.toggle") return matchesKey(data, "ctrl+t");
		return false;
	},
};
const trees: Subagents[] = [];
const screens: SubagentSwitcher[] = [];
afterEach(async () => {
	for (const screen of screens.splice(0)) screen.dispose();
	await Promise.all(trees.splice(0).map((tree) => tree.dispose()));
});
async function setup(empty = false) {
	const tree = createSubagentRuntime();
	trees.push(tree);
	if (!empty) {
		const context = await spawnContext();
		await tree.start(ROOT, "first", context).result;
		await tree.start(ROOT, "second", context).result;
	}
	const tui = { terminal: { rows: 24 }, requestRender: mock(() => {}) };
	const screen = createSubagentSwitcher({
		runtime: tree,
		tui,
		theme,
		keybindings: keys,
		onClose() {},
	});
	screens.push(screen);
	screen.focused = true;
	return { tree, screen, tui };
}
function output(screen: SubagentSwitcher) {
	return stripTerminalSequences(screen.render(80).join("\n"));
}
function mouse(
	y: number,
	overrides: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 45,
		y,
		screenX: 45,
		screenY: y,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}
function pane(screen: SubagentSwitcher) {
	return screen
		.render(80)
		.slice(3, -5)
		.map((line) => stripTerminalSequences(line).split("│")[2]?.trimEnd());
}

test("multiline editor preserves cursor, undo, paste and history separately for each agent", async () => {
	const { tree, screen } = await setup();
	screen.handleInput("alpha");
	screen.handleInput("\n"); // Ctrl+J, the standard newline fallback.
	screen.handleInput("beta");
	screen.handleInput("\x1b[D");
	screen.handleInput("\t");
	screen.handleInput("second draft");
	screen.handleInput("\x1b[Z");
	screen.handleInput("X");
	screen.handleInput("\x1b[45;5u"); // Ctrl+- undo, via the Kitty keyboard protocol.
	expect(output(screen)).toContain("beta");
	screen.handleInput("X");
	expect(output(screen)).toContain("alpha");
	expect(output(screen)).toContain("betXa");
	expect(screen.render(80).join("\n")).toContain(CURSOR_MARKER);
	screen.handleInput("\r");
	await until(() => tree.get("1")?.status === "done");
	expect(JSON.stringify(tree.get("1")?.session?.messages)).toContain(
		"alpha\\nbetXa",
	);
	expect(JSON.stringify(tree.get("2")?.session?.messages)).not.toContain(
		"betXa",
	);
	screen.handleInput("\x1b[A"); // History restores the complete multiline prompt.
	expect(output(screen)).toContain("betXa");
	screen.handleInput("\t");
	expect(output(screen)).toContain("second draft");
	screen.handleInput("\r");
	await until(() => tree.get("2")?.status === "done");
	screen.handleInput("\x1b[200~pasted first\n");
	screen.handleInput("pasted\tsecond\x1b[201~");
	expect(output(screen)).toContain("Subagents · 2");
	screen.handleInput("\r");
	await until(() => tree.get("2")?.status === "done");
	expect(JSON.stringify(tree.get("2")?.session?.messages)).toContain(
		"pasted first\\npasted    second",
	);
});

test("mouse wheel scrolls the transcript; incoming messages and switching agents retain the scroll anchor", async () => {
	const { tree, screen } = await setup();
	await tree.send(
		"1",
		Array.from({ length: 80 }, (_, i) => `history ${i}`).join("\n"),
	);
	expect(output(screen)).toContain("history 79");
	expect(
		screen.handleMouse(
			mouse(6, { type: "wheel", button: "none", wheelDelta: -20 }),
		),
	).toMatchObject({ handled: true, render: true });
	const paused = pane(screen);
	expect(output(screen)).not.toContain("history 79");
	await tree.get("1")?.session?.sendCustomMessage({
		customType: "incoming",
		display: true,
		content: Array.from({ length: 30 }, (_, i) => `arrival ${i}`).join("\n"),
	});
	expect(pane(screen)).toEqual(paused);
	screen.handleInput("\t");
	screen.render(80);
	screen.handleInput("\x1b[Z");
	expect(pane(screen)).toEqual(paused);
	screen.handleInput("\x1b[1;5F"); // Ctrl+End follows live output again.
	expect(output(screen)).toContain("arrival 29");
	screen.handleMouse(
		mouse(6, { type: "wheel", button: "none", wheelDelta: -1 }),
	);
	screen.render(80);
	screen.handleMouse(
		mouse(6, { type: "wheel", button: "none", wheelDelta: 1000 }),
	);
	expect(output(screen)).toContain("arrival 29");
	expect(output(screen)).not.toContain("paused");
});

test("a real bash tool streams command logs before exit and remains independently collapsible", async () => {
	const { tree, screen, tui } = await setup(true);
	const context = await spawnContext();
	const gate = join(context.cwd, "release-command");
	const command = `printf 'FIRST_LOG\\n'; while [ ! -f '${gate}' ]; do sleep 0.01; done; printf 'LAST_LOG\\n'`;
	if (!context.modelRuntime) throw new Error("Missing model runtime");
	const dispatch = stream((transcript) =>
		transcript.messages.at(-1)?.role === "toolResult"
			? response("command finished")
			: toolCall("bash", { command }),
	);
	// Register through both runtime and discoverable provider, as real child sessions do.
	const configured = await spawnContext(dispatch);
	configured.cwd = context.cwd;
	const result = tree.start(ROOT, "run slow command", configured).result;
	try {
		await until(() =>
			[...(tree.get("1")?.liveTools.values() ?? [])].some((tool) =>
				tool.result?.content.some(
					(part) => part.type === "text" && part.text.includes("FIRST_LOG"),
				),
			),
		);
		expect(tree.get("1")?.status).toBe("running");
		expect(output(screen)).toContain("FIRST_LOG");
		expect(output(screen)).not.toContain("LAST_LOG");
		expect(tui.requestRender).toHaveBeenCalled();
		let header = screen.render(80).findIndex((line) => line.includes("▸ bash"));
		expect(header).toBeGreaterThan(0);
		expect(
			screen.handleMouse(mouse(header, { type: "press" })),
		).toBeUndefined();
		expect(screen.handleMouse(mouse(header))).toMatchObject({ handled: true });
		expect(output(screen)).toContain("▾ bash [running]");
		await writeFile(gate, "release");
		expect((await result).status).toBe("done");
		expect(output(screen)).toContain("LAST_LOG");
		header = screen.render(80).findIndex((line) => line.includes("▾ bash"));
		screen.handleMouse(mouse(header));
		expect(output(screen)).toContain("▸ bash [done]");
		screen.handleInput("\x0f"); // Ctrl+O expands tools, not thinking.
		expect(output(screen)).toContain("▾ bash [done]");
		screen.handleInput("\x14");
		expect(output(screen)).toContain("▾ bash [done]");
	} finally {
		await writeFile(gate, "release");
		await result;
	}
});

test("Shift+Enter and backslash-Enter insert newlines; large pastes are expanded on submit", async () => {
	const { tree, screen } = await setup();
	const changes = mock(() => {});
	tree.subscribe(changes);
	screen.handleInput("first line");
	screen.handleInput("\x1b[13;2u"); // Shift+Enter, via Kitty.
	screen.handleInput("second line\\");
	screen.handleInput("\r"); // The fallback for terminals without Shift+Enter.
	expect(changes).not.toHaveBeenCalled();
	screen.handleInput("third line");
	const payload = `\n${"large pasted line\n".repeat(150)}`;
	screen.handleInput(`\x1b[200~${payload}\x1b[201~`);
	screen.handleInput("\r");
	await until(() => tree.get("1")?.status === "done");
	const message = tree
		.get("1")
		?.session?.messages.findLast((entry) => entry.role === "user");
	if (message?.role !== "user") throw new Error("Missing pasted message");
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n");
	expect(text).toBe(`first line\nsecond line\nthird line${payload}`.trim());
	expect(text).not.toContain("[paste");
});
