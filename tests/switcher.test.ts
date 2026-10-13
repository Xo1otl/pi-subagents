import { afterEach, expect, mock, test } from "bun:test";
import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	matchesKey,
	stripTerminalSequences,
	type Terminal,
	Text,
	TuiAltScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createSubagentRuntime } from "../agent/index.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	createSubagentSwitcher,
	type SubagentSwitcher,
	type SwitcherFocus,
} from "../ui/switcher.ts";
import { response, spawnContext, stream, until, waiting } from "./fixtures.ts";

const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };
const keybindings: Pick<KeybindingsManager, "matches"> = {
	matches(data, action) {
		if (action === "app.interrupt") return matchesKey(data, "escape");
		if (action === "tui.input.submit") return matchesKey(data, "enter");
		if (action === "tui.editor.pageUp") return matchesKey(data, "pageUp");
		if (action === "tui.editor.pageDown") return matchesKey(data, "pageDown");
		if (action === "tui.altScreen.top") return matchesKey(data, "ctrl+home");
		if (action === "tui.altScreen.bottom") return matchesKey(data, "ctrl+end");
		if (action === "app.tools.expand") return matchesKey(data, "ctrl+o");
		if (action === "app.thinking.toggle") return matchesKey(data, "ctrl+t");
		return false;
	},
};
const trees: Subagents[] = [];
const switchers: SubagentSwitcher[] = [];
afterEach(async () => {
	for (const switcher of switchers.splice(0)) switcher.dispose();
	await Promise.all(trees.splice(0).map((tree) => tree.dispose()));
});

async function setup({
	empty = false,
	initialFocus,
	theme: currentTheme = theme,
}: {
	empty?: boolean;
	initialFocus?: SwitcherFocus;
	theme?: Pick<Theme, "fg">;
} = {}) {
	const tree = createSubagentRuntime();
	trees.push(tree);
	if (!empty) {
		await tree.start(ROOT, "nest:1", await spawnContext()).result;
		await tree.start(ROOT, "other", await spawnContext()).result;
	}
	const tui = { requestRender: mock(() => {}), terminal: { rows: 24 } };
	const done = mock(() => {});
	const switcher = createSubagentSwitcher({
		runtime: tree,
		tui,
		theme: currentTheme,
		keybindings,
		onClose: done,
		initialFocus,
	});
	switchers.push(switcher);
	return { tree, tui, switcher, done };
}

function mouse(
	y: number,
	overrides: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 10,
		y,
		// Overlay-local coordinates, not absolute terminal coordinates, drive selection.
		screenX: 110,
		screenY: y + 20,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

function agentRow(switcher: SubagentSwitcher, id: string): number {
	const row = switcher.render(80).findIndex((line) =>
		stripTerminalSequences(line)
			.replace(/^[│> ]+/, "")
			.startsWith(`${id} [`),
	);
	if (row < 0) throw new Error(`Subagent ${id} is not visible`);
	return row;
}

test("clicks select descendants, preserve drafts and route messages without submitting on selection", async () => {
	const { tree, switcher } = await setup();
	switcher.focused = true;
	switcher.handleInput("root child draft");
	const changes = mock(() => {});
	tree.subscribe(changes);
	expect(switcher.handleMouse(mouse(agentRow(switcher, "1.1")))).toMatchObject({
		handled: true,
		focus: true,
	});
	expect(changes).not.toHaveBeenCalled();
	expect(switcher.render(80)[1]).toContain("1.1");
	expect(switcher.render(80).join("\n")).toContain(CURSOR_MARKER);
	switcher.handleInput("leaf draft");
	switcher.handleMouse(mouse(agentRow(switcher, "1")));
	expect(stripTerminalSequences(switcher.render(80).join("\n"))).toContain(
		"root child draft",
	);
	switcher.handleMouse(mouse(agentRow(switcher, "1.1")));
	expect(stripTerminalSequences(switcher.render(80).join("\n"))).toContain(
		"leaf draft",
	);
	switcher.handleInput("\r");
	await until(() => tree.get("1.1")?.status === "done");
	expect(JSON.stringify(tree.get("1.1")?.session?.messages)).toContain(
		"leaf draft",
	);
	expect(JSON.stringify(tree.get("1")?.session?.messages)).not.toContain(
		"leaf draft",
	);
});

test("press and click retain the same agent when selection recenters the visible tree", async () => {
	const { tree, switcher } = await setup();
	const context = await spawnContext();
	for (let i = 0; i < 25; i++) await tree.start(ROOT, "extra", context).result;
	const row = agentRow(switcher, "14");
	switcher.handleMouse(mouse(row, { type: "press" }));
	expect(switcher.render(80)[1]).toContain("Subagents · 14");
	// The original pointer row now renders a different agent.
	expect(switcher.render(80)[row]).not.toContain("14 [");
	switcher.handleMouse(mouse(row, { type: "release" }));
	switcher.handleMouse(mouse(row));
	expect(switcher.render(80)[1]).toContain("Subagents · 14");
	const nextRow = agentRow(switcher, "15");
	switcher.handleMouse(mouse(nextRow, { type: "press" }));
	switcher.render(80);
	switcher.handleMouse(mouse(nextRow, { type: "release" }));
	switcher.handleMouse(mouse(nextRow));
	expect(switcher.render(80)[1]).toContain("Subagents · 15");
});

test("fullscreen mouse reports select through the real overlay dispatcher and retain composer focus", async () => {
	const { tree } = await setup();
	const context = await spawnContext();
	for (let i = 0; i < 25; i++) await tree.start(ROOT, "extra", context).result;
	let input = (_data: string) => {};
	const terminal: Terminal = {
		columns: 100,
		rows: 24,
		kittyProtocolActive: false,
		start: (onInput) => {
			input = onInput;
		},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
	const tui = new TuiAltScreen(terminal);
	tui.addChild(new Text("ROOT_TRANSCRIPT_BEHIND_SWITCHER", 0, 0));
	const switcher = createSubagentSwitcher({
		runtime: tree,
		tui,
		theme,
		keybindings,
		onClose() {},
	});
	switchers.push(switcher);
	const overlay = tui.showOverlay(switcher, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
	});
	try {
		tui.start();
		tui.renderNow(true);
		const bounds = overlay.getBounds();
		if (!bounds) throw new Error("Overlay has not rendered");
		expect(bounds).toEqual({ col: 0, row: 0, width: 100, height: 24 });
		expect(tui.getScreenLines().join("\n")).not.toContain(
			"ROOT_TRANSCRIPT_BEHIND_SWITCHER",
		);
		const row = tui.getScreenLines().findIndex((line) =>
			stripTerminalSequences(line)
				.replace(/^[│> ]+/, "")
				.startsWith("14 ["),
		);
		expect(row).toBeGreaterThanOrEqual(0);
		const coordinates = `${bounds.col + 4};${row + 1}`;
		input(`\x1b[<0;${coordinates}M`);
		tui.renderNow(true);
		input(`\x1b[<0;${coordinates}m`);
		tui.renderNow(true);
		expect(tui.getScreenLines().join("\n")).toContain("Subagents · 14");
		expect(switcher.focused).toBe(true);
		input("message after clicking");
		input("\r");
		await until(() => tree.get("14")?.status === "done");
		expect(JSON.stringify(tree.get("14")?.session?.messages)).toContain(
			"message after clicking",
		);
		await tree.send(
			"14",
			Array.from({ length: 70 }, (_, i) => `wheel log ${i}`).join("\n"),
		);
		tui.renderNow(true);
		expect(tui.getScreenLines().join("\n")).toContain("wheel log 69");
		input("\x1b[<64;70;10M"); // Real SGR mouse wheel, not a direct component call.
		tui.renderNow(true);
		expect(tui.getScreenLines().join("\n")).toContain("paused");
		expect(tui.getScreenLines().join("\n")).not.toContain("wheel log 69");
		input("\x1b[1;5F");
		tui.renderNow(true);
		expect(tui.getScreenLines().join("\n")).toContain("wheel log 69");
	} finally {
		overlay.hide();
		tui.stop();
	}
});

test("clicks target the last-rendered rows, not a tree updated between rendering and input", async () => {
	const { tree, switcher } = await setup();
	const row = agentRow(switcher, "2");
	await tree.start(
		"1",
		"new descendant inserted before sibling",
		await spawnContext(),
	).result;
	switcher.handleMouse(mouse(row));
	expect(switcher.render(80)[1]).toContain("Subagents · 2");
});

test("non-tree rows, borders and non-primary clicks do not select or submit", async () => {
	const { switcher } = await setup();
	const row = agentRow(switcher, "2");
	const lines = switcher.render(80);
	for (const event of [
		mouse(0),
		mouse(1),
		mouse(lines.length - 1),
		mouse(lines.length - 3),
		mouse(row, { x: 0 }),
		mouse(row, { x: 79 }),
		mouse(row, { x: 25 }), // The split divider.
		mouse(row, { x: 45 }), // Same row, but in the conversation pane.
		mouse(row, { x: -1 }),
		mouse(row, { button: "right" }),
		mouse(row, { button: "middle" }),
		mouse(row, { type: "move" }),
		mouse(row, { type: "drag" }),
		mouse(row, { type: "wheel", wheelDelta: 1 }),
	])
		expect(switcher.handleMouse(event)).toBeUndefined();
	expect(switcher.render(80)[1]).toContain("Subagents · 1");
	switcher.dispose();
	expect(switcher.handleMouse(mouse(row))).toBeUndefined();
});

test("resize rebuilds click bounds for framed, unframed and tiny layouts", async () => {
	const { switcher, tui } = await setup();
	expect(switcher.handleMouse(mouse(4))).toBeUndefined();
	switcher.render(80);
	switcher.render(3);
	switcher.handleMouse(mouse(4, { x: 1, width: 3 }));
	expect(switcher.render(80)[1]).toContain("Subagents · 2");
	switcher.invalidate();
	expect(switcher.handleMouse(mouse(2))).toBeUndefined();
	switcher.render(20);
	expect(switcher.handleMouse(mouse(2, { x: 1, width: 20 }))).toBeUndefined();
	switcher.handleMouse(mouse(3, { x: 1, width: 20 }));
	expect(switcher.render(80)[1]).toContain("Subagents · 1");
	tui.terminal.rows = 4;
	switcher.render(80);
	// At this height only the standard editor fits; clicks cannot select a tree row.
	expect(switcher.handleMouse(mouse(2))).toMatchObject({
		handled: true,
		focus: true,
	});
	tui.terminal.rows = 24;
	expect(switcher.render(80)[1]).toContain("Subagents · 1");
});

test("selects the first arriving child before rendering or handling submit", async () => {
	const { tree, switcher } = await setup({ empty: true });
	expect(switcher.render(80).join("\n")).toContain("No subagents yet.");
	await tree.start(ROOT, "hello", await spawnContext()).result;
	switcher.handleInput("selected without rendering");
	switcher.handleInput("\r");
	await until(() => tree.get("1")?.status === "done");
	expect(JSON.stringify(tree.get("1")?.session?.messages)).toContain(
		"selected without rendering",
	);
});

test("renders displayed extension messages from the child's raw transcript, not hidden ones", async () => {
	const { tree, switcher } = await setup();
	const session = tree.get("1")?.session;
	await session?.sendCustomMessage({
		customType: "extension-note",
		content: "EXTENSION_MESSAGE_MARKER",
		display: true,
	});
	await session?.sendCustomMessage({
		customType: "private-note",
		content: "HIDDEN_NOTE",
		display: false,
	});
	const output = switcher.render(80).join("\n");
	expect(output).toContain("EXTENSION_MESSAGE_MARKER");
	expect(output).not.toContain("HIDDEN_NOTE");
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
	tui.requestRender.mockClear();
	tui.terminal.rows = 100;
	switcher.render(80);
	tui.terminal.rows = 24;
	expect(switcher.render(80)).toEqual(expected);
	switcher.invalidate();
	expect(switcher.render(80)).toEqual(expected);
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
	expect(switcher.render(100)[1]).toContain("1.1");
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
	expect(switcher.render(100)[1]).toContain("2");
	switcher.handleInput("\t");
	expect(stripTerminalSequences(switcher.render(100).join("\n"))).toContain(
		"draft",
	);
	switcher.handleInput("\x1b[Z");
	expect(switcher.render(100)[1]).toContain("2");
	switcher.handleInput("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
});

test("fills any terminal size with wide Unicode, keeps the composer cursor visible and propagates IME focus", async () => {
	const { tree, switcher, tui } = await setup();
	await tree.send("1", "日本語🙂".repeat(50));
	switcher.focused = true;
	switcher.handleInput("界🙂draft");
	for (const rows of [2, 5, 9, 10, 24, 40]) {
		tui.terminal.rows = rows;
		for (const width of [1, 3, 4, 5, 20, 40, 41, 42, 80, 120]) {
			switcher.invalidate();
			const lines = switcher.render(width);
			expect(lines.length).toBe(rows);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
			expect(lines[0]?.startsWith("╭")).toBe(width >= 5 && rows >= 8);
			expect(lines.join("\n")).toContain(CURSOR_MARKER);
		}
	}
	tui.terminal.rows = 24;
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
	const child = tree.start("1.1", "wait", context).result;
	await until(() => Boolean(tree.get("1.1.1")?.session?.isStreaming));
	switcher.handleInput("\x03");
	await child;
	expect(tree.get("1.1.1")?.status).toBe("aborted");
	const siblings = Promise.all([
		tree.start(ROOT, "wait", context).result,
		tree.start(ROOT, "wait", context).result,
	]);
	await until(() => Boolean(tree.get("4")?.session?.isStreaming));
	await tree.dispose();
	await siblings;
	switcher.handleInput("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
});

test("shows the tree and conversation side by side with a conversation-only composer", async () => {
	const { tree, switcher } = await setup({ empty: true });
	await tree.start(ROOT, "SIDE_BY_SIDE_MARKER", await spawnContext()).result;
	const lines = switcher.render(80).map(stripTerminalSequences);
	expect(lines[2]?.split("│")[1]).toContain("Tree");
	expect(lines[2]?.split("│")[2]).toContain("1/1 · done");
	expect(lines[3]?.split("│")[1]).toContain("1 [done]");
	expect(lines[3]?.split("│")[2]).toContain("user");
	expect(
		lines.some((line) => line.split("│")[2]?.includes("SIDE_BY_SIDE_MARKER")),
	).toBe(true);
	const composer = lines.find((line) => line.includes("Message this subagent"));
	expect(composer?.split("│")[1]?.trim()).toBe("");
	expect(composer?.split("│")[2]).toContain("Message this subagent");
});

test.each([20, 80])(
	"an accent dot marks the active pane at width %i and disappears on blur",
	async (width) => {
		const fg = mock((_color: Parameters<Theme["fg"]>[0], text: string) => text);
		const { switcher } = await setup({ theme: { fg } });
		const output = () =>
			stripTerminalSequences(switcher.render(width).join("\n"));
		switcher.focused = true;
		expect(output()).toContain("● 1/3");
		expect(output()).not.toContain("● Tree");
		expect(fg).toHaveBeenCalledWith("accent", "●");
		switcher.handleInput("\x1b[D");
		switcher.handleInput("\x1b[D");
		expect(output()).toContain("● Tree");
		expect(output()).not.toContain("● 1/3");
		expect(output()).not.toContain("> Tree");
		switcher.focused = false;
		fg.mockClear();
		expect(output()).not.toContain("●");
		expect(fg).not.toHaveBeenCalledWith("accent", "●");
		switcher.focused = true;
		expect(output()).toContain("● Tree");
		switcher.handleInput("\r");
		expect(output()).toContain("● 1/3");
		expect(output()).not.toContain("● Tree");
	},
);

test("double Left focuses the tree from an empty composer; Enter returns without sending", async () => {
	const { tree, switcher } = await setup();
	switcher.focused = true;
	const changes = mock(() => {});
	tree.subscribe(changes);
	expect(switcher.render(240).join("\n")).toContain("←← tree (at text start)");
	switcher.handleInput("\x1b[D");
	expect(switcher.render(80).join("\n")).toContain(CURSOR_MARKER);
	switcher.handleInput("\x1b[D");
	expect(switcher.focused).toBe(true);
	expect(switcher.render(80).join("\n")).not.toContain(CURSOR_MARKER);
	expect(switcher.render(80).join("\n")).toContain("● Tree");
	switcher.handleInput("\r");
	expect(changes).not.toHaveBeenCalled();
	expect(switcher.render(80).join("\n")).toContain(CURSOR_MARKER);
});

test("a multiline draft keeps editing until double Left at the text start", async () => {
	const { tree, switcher } = await setup();
	switcher.focused = true;
	const changes = mock(() => {});
	tree.subscribe(changes);
	switcher.handleInput("\x1b[200~first\nsecond\x1b[201~");
	for (let i = 0; i < "first\nsecond".length; i++) {
		switcher.handleInput("\x1b[D");
		expect(switcher.render(80).join("\n")).toContain(CURSOR_MARKER);
	}
	switcher.handleInput("\x1b[D");
	expect(switcher.render(80).join("\n")).toContain(CURSOR_MARKER);
	switcher.handleInput("\x1b[D");
	expect(switcher.render(80).join("\n")).not.toContain(CURSOR_MARKER);
	expect(switcher.render(80).join("\n")).toContain("● Tree");
	switcher.handleInput("\r");
	expect(changes).not.toHaveBeenCalled();
	switcher.handleInput("X");
	expect(stripTerminalSequences(switcher.render(80).join("\n"))).toContain(
		"Xfirst",
	);
});

test.each(["editing", "paste", "split paste", "focus", "agent switch"])(
	"%s clears a pending empty-composer chord",
	async (interruption) => {
		const { switcher } = await setup();
		switcher.focused = true;
		switcher.handleInput("\x1b[D");
		if (interruption === "editing") {
			switcher.handleInput("temporary draft");
			switcher.handleInput("\x15"); // Ctrl+U restores an empty composer.
		} else if (interruption === "paste")
			switcher.handleInput("\x1b[200~\x1b[201~");
		else if (interruption === "split paste") {
			switcher.handleInput("\x1b[200~");
			switcher.handleInput("\x1b[201~");
		} else if (interruption === "focus") {
			switcher.focused = false;
			switcher.focused = true;
		} else {
			switcher.handleInput("\t");
			switcher.handleInput("\x1b[Z");
		}
		switcher.handleInput("\x1b[D");
		expect(switcher.render(80).join("\n")).toContain(CURSOR_MARKER);
		switcher.handleInput("\x1b[D");
		expect(switcher.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		expect(switcher.render(80).join("\n")).toContain("● Tree");
	},
);

test("tree arrows traverse descendants and parents, clamp at the ends and restore drafts", async () => {
	const { tree, switcher } = await setup();
	switcher.focused = true;
	switcher.handleInput("parent draft");
	switcher.handleInput("\t"); // Use an empty composer without discarding the draft.
	switcher.handleInput("\x1b[D");
	switcher.handleInput("\x1b[D");
	switcher.handleInput("\x1b[D"); // Return to the parent in the tree.
	const selected = (id: string) => {
		expect(switcher.render(80)[1]).toContain(`Subagents · ${id}`);
		expect(switcher.render(80).join("\n")).not.toContain(CURSOR_MARKER);
	};
	switcher.handleInput("\x1b[A");
	selected("1");
	switcher.handleInput("\x1b[B");
	selected("1.1");
	switcher.handleInput("\x1b[D");
	selected("1");
	switcher.handleInput("\x1b[D"); // A top-level agent has no selectable parent.
	selected("1");
	switcher.handleInput("\x1b[C");
	selected("1.1");
	switcher.handleInput("\x1b[B");
	selected("2");
	switcher.handleInput("\x1b[B");
	selected("2");
	switcher.handleInput("\x1b[A");
	selected("1.1");
	switcher.handleInput("\x1b[C"); // A leaf's Right key enters its composer.
	expect(switcher.render(80).join("\n")).toContain(CURSOR_MARKER);
	switcher.handleInput("leaf draft");
	switcher.handleInput("\t"); // The sibling's composer is empty.
	switcher.handleInput("\x1b[D");
	switcher.handleInput("\x1b[D");
	switcher.handleInput("\x1b[A");
	switcher.handleInput("\x1b[D");
	selected("1");
	switcher.handleInput("\r");
	expect(stripTerminalSequences(switcher.render(80).join("\n"))).toContain(
		"parent draft",
	);
	switcher.handleInput("\r");
	await until(() => tree.get("1")?.status === "done");
	expect(JSON.stringify(tree.get("1")?.session?.messages)).toContain(
		"parent draft",
	);
	expect(JSON.stringify(tree.get("1.1")?.session?.messages)).not.toContain(
		"parent draft",
	);
});

test("initial tree focus survives host focus changes and clicking the composer resumes editing", async () => {
	const { tree, switcher } = await setup({ initialFocus: "tree" });
	switcher.focused = true;
	switcher.handleInput("\x1b[B");
	switcher.focused = false;
	switcher.focused = true;
	const lines = switcher.render(80);
	expect(lines[1]).toContain("Subagents · 1.1");
	expect(lines.join("\n")).not.toContain(CURSOR_MARKER);
	expect(lines.join("\n")).toContain("● Tree");
	expect(
		switcher.handleMouse(mouse(lines.length - 4, { x: 30 })),
	).toMatchObject({ handled: true, focus: true });
	expect(switcher.render(80).join("\n")).toContain(CURSOR_MARKER);
	expect(switcher.render(80).join("\n")).not.toContain("● Tree");
	expect(switcher.render(80).join("\n")).toContain("● 2/3");
	switcher.handleInput("leaf message");
	switcher.handleInput("\r");
	await until(() => tree.get("1.1")?.status === "done");
	expect(JSON.stringify(tree.get("1.1")?.session?.messages)).toContain(
		"leaf message",
	);
});
