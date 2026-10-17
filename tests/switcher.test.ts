import { afterEach, expect, mock, test } from "bun:test";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { createSubagentRuntime } from "../agent/index.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	createSubagentSwitcher,
	type SubagentSwitcher,
} from "../ui/switcher.ts";
import {
	blockingTool,
	fullscreen,
	lastText,
	response,
	spawnContext,
	stream,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

const theme = { fg: (_color: string, text: string) => text };
const left = "\x1b[D";
const trees: Subagents[] = [];
const switchers: SubagentSwitcher[] = [];
const terminals: ReturnType<typeof fullscreen>[] = [];
afterEach(async () => {
	for (const switcher of switchers.splice(0)) switcher.dispose();
	for (const terminal of terminals.splice(0)) terminal.stop();
	await Promise.all(trees.splice(0).map((tree) => tree.dispose()));
});

/** Open the switcher the way ctx.ui.custom() does with an overlay. */
async function setup({
	agents = true,
	initialId,
	columns = 80,
}: {
	agents?: boolean;
	initialId?: string;
	columns?: number;
} = {}) {
	const tree = createSubagentRuntime();
	trees.push(tree);
	if (agents) {
		await tree.start(ROOT, "nest:1", await spawnContext()).result;
		await tree.start(ROOT, "other", await spawnContext()).result;
	}
	const terminal = fullscreen({ columns });
	terminals.push(terminal);
	let overlay: OverlayHandle | undefined;
	const done = mock(() => overlay?.hide());
	const switcher = createSubagentSwitcher({
		runtime: tree,
		tui: terminal.tui,
		theme,
		keybindings: terminal.keybindings,
		onClose: done,
		initialId,
	});
	switchers.push(switcher);
	overlay = terminal.mount(switcher);
	/** The picker's or the chat's first line, wherever the overlay sits. */
	const header = () =>
		terminal.screen().find((line) => line.startsWith("Subagent")) ?? "";
	/** The composer's text rows, below its labeled top border. */
	const composer = () => {
		const lines = terminal.screen();
		const top = lines.findIndex((line) => line.includes("Message this"));
		return lines.slice(top + 1, -2).join("\n");
	};
	return { tree, terminal, switcher, done, header, composer };
}

function spyRenders(tui: TUI) {
	const spy = mock(tui.requestRender.bind(tui));
	tui.requestRender = spy;
	return spy;
}

test("the compact picker lists every descendant's status, task and context below the root, and arrows walk the tree", async () => {
	const { terminal } = await setup();
	const lines = terminal.screen();
	expect(lines).toHaveLength(24);
	expect(lines[0]).toContain("ROOT_TRANSCRIPT");
	expect(lines.slice(-6)).toEqual([
		expect.stringMatching(/^─+$/),
		"Subagents · 3 · context",
		expect.stringMatching(/^> 1 \[done\] nest:1 +0\.0%$/),
		expect.stringMatching(/^ {4}1\.1 \[done\] nest:0 +\d/),
		expect.stringMatching(/^ {2}2 \[done\] other/),
		expect.stringContaining("Enter open"),
	]);
	expect(terminal.cursor()).toBeUndefined();
	const selected = () => terminal.screen().find((line) => line.startsWith(">"));
	terminal.input("\x1b[A"); // Clamped at the top.
	expect(selected()).toStartWith("> 1 [");
	terminal.input("\x1b[C"); // Right selects the first child.
	expect(selected()).toStartWith(">   1.1 [");
	terminal.input(left); // Left selects the parent.
	expect(selected()).toStartWith("> 1 [");
	terminal.input(left); // A top-level agent has no selectable parent.
	expect(selected()).toStartWith("> 1 [");
	for (let i = 0; i < 3; i++) terminal.input("\x1b[B"); // Clamped at the bottom.
	expect(selected()).toStartWith("> 2 [");
	terminal.input("\x1b[C"); // A leaf's Right opens its chat, which fills the screen.
	expect(terminal.screen()[0]).toContain("Subagent 2 · 3/3 · done · ctx");
	expect(terminal.text()).not.toContain("ROOT_TRANSCRIPT");
	expect(terminal.cursor()).toEqual({
		row: terminal.row("Message this subagent") + 1,
		col: 0,
	});
});

test("clicks open agents and place the composer cursor without taking focus; wheels never scroll pi's screen beneath", async () => {
	const { terminal, switcher, header } = await setup();
	terminal.mouse(64, 10, terminal.row("  2 [done]")); // Wheel up over the picker.
	expect(terminal.tui.isFollowingOutput).toBe(true);
	terminal.click(4, terminal.row("  2 [done]"));
	expect(header()).toContain("Subagent 2");
	terminal.input("message after clicking");
	terminal.click(0, terminal.row("message after clicking"));
	terminal.input("X");
	expect(terminal.text()).toContain("Xmessage after clicking");
	expect(terminal.tui.getFocusedComponent()).toBe(switcher);
	terminal.mouse(64, 10, 5); // Wheel up over a chat that fits the screen.
	expect(terminal.tui.isFollowingOutput).toBe(true);
});

test("each agent keeps its draft, undo and history across Tab and the picker; Enter sends to the selected child", async () => {
	const { tree, terminal, header, composer } = await setup({ initialId: "1" });
	const messages = (id: string) =>
		JSON.stringify(tree.get(id)?.session?.messages);
	terminal.input("alpha");
	terminal.input("\n"); // Ctrl+J inserts a newline.
	terminal.input("beta");
	terminal.input("\t");
	expect(header()).toContain("Subagent 1.1 · 2/3");
	expect(composer()).not.toContain("beta");
	terminal.input("message the leaf");
	terminal.input("\r");
	await until(() => messages("1.1").includes("message the leaf"));
	expect(messages("1")).not.toContain("message the leaf");
	terminal.input("leaf draft");
	terminal.input("\t");
	expect(header()).toContain("Subagent 2");
	terminal.input("\t"); // Wraps around.
	expect(composer()).toContain("alpha\nbeta");
	terminal.input(left);
	terminal.input("X");
	expect(composer()).toContain("alpha\nbetXa");
	terminal.input("\x1b[45;5u"); // Ctrl+- undoes, via the Kitty keyboard protocol.
	expect(composer()).toContain("alpha\nbeta");
	terminal.input("\x1b[Z"); // Shift+Tab wraps backwards.
	expect(header()).toContain("Subagent 2");
	terminal.input(left);
	terminal.input(left);
	expect(header()).toContain("Subagents · 3");
	terminal.input("\x1b[A");
	terminal.input("\r");
	expect(header()).toContain("Subagent 1.1");
	expect(composer()).toContain("leaf draft");
	terminal.input("\x15"); // Ctrl+U clears the line; Up recalls this agent's history.
	terminal.input("\x1b[A");
	expect(composer()).toContain("message the leaf");
	terminal.input("\x1b[Z");
	terminal.input("\r");
	await until(() => messages("1").includes("alpha\\nbeta"));
});

test("Left twice at the text start returns to the picker; nothing inside a bracketed paste is a shortcut", async () => {
	const { tree, terminal, done, header, composer } = await setup({
		initialId: "1",
		columns: 240,
	});
	expect(terminal.text()).toContain("←← agents (at text start)");
	const sent = mock(() => {});
	tree.subscribe(sent);
	for (const chunk of ["\x1b[200~", left, left, "\t", "\x1b", "\x1b[201~"])
		terminal.input(chunk);
	expect(done).not.toHaveBeenCalled();
	expect(header()).toContain("Subagent 1 ");
	expect(composer()).toContain("[D[D");
	terminal.input("\x15");
	terminal.input("\x1b[200~first\nsecond\x1b[201~");
	// Lefts that move the cursor never arm the chord.
	for (let i = 0; i < "first\nsecond".length; i++) terminal.input(left);
	expect(header()).toContain("Subagent 1 ");
	terminal.input(left);
	terminal.input("\x1b[200~\x1b[201~"); // A paste disarms it,
	terminal.input(left);
	terminal.input("\t");
	terminal.input("\x1b[Z"); // and so does switching agents.
	terminal.input(left);
	expect(header()).toContain("Subagent 1 ");
	terminal.input(left);
	expect(header()).toContain("Subagents · 3");
	expect(terminal.cursor()).toBeUndefined();
	terminal.input("\r");
	terminal.input("X");
	expect(composer()).toContain("Xfirst\nsecond");
	expect(sent).not.toHaveBeenCalled();
});

test("Ctrl+C stops the selected subtree, and runtime shutdown closes the switcher once", async () => {
	const { tree, terminal, done } = await setup();
	const context = await spawnContext(
		stream((_context, options) => waiting(options?.signal)),
	);
	const child = tree.start("1.1", "wait", context).result;
	await until(() => Boolean(tree.get("1.1.1")?.session?.isStreaming));
	expect(terminal.text()).toContain("1.1.1 [running]");
	terminal.input("\x03");
	await child;
	expect(tree.get("1.1.1")?.status).toBe("aborted");
	const siblings = Promise.all([
		tree.start(ROOT, "wait", context).result,
		tree.start(ROOT, "wait", context).result,
	]);
	await until(() => Boolean(tree.get("4")?.session?.isStreaming));
	await tree.dispose();
	await siblings;
	expect(done).toHaveBeenCalledTimes(1);
	expect(terminal.text()).toContain("ROOT_TRANSCRIPT");
	terminal.input("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
});

test("a message sent during a blocking tool stays visible as queued, and Ctrl+C returns it to the draft", async () => {
	const { tree, terminal, composer } = await setup({
		agents: false,
		initialId: "1",
	});
	const context = await spawnContext(
		stream((context) =>
			lastText(context) === "monitor"
				? toolCall("blocking", {})
				: response(lastText(context)),
		),
	);
	await blockingTool(context);
	const result = tree.start(ROOT, "monitor", context).result;
	await until(() =>
		[...(tree.get("1")?.liveTools.values() ?? [])].some(
			(tool) => tool.status === "running",
		),
	);
	terminal.input("QUEUED_MESSAGE");
	terminal.input("\r");
	await until(() => tree.get("1")?.queuedInput.length === 1);
	expect(terminal.text()).toContain("queued");
	expect(terminal.text()).toContain("QUEUED_MESSAGE");
	terminal.input("newer draft");
	terminal.input("\x03");
	expect((await result).status).toBe("aborted");
	expect(composer()).toContain("QUEUED_MESSAGE\n\nnewer draft");
	expect(terminal.text()).not.toContain("queued");
});

test("context usage is unknown during startup, then shows the latest request in the header and the picker", async () => {
	const { tree, terminal, header } = await setup({
		agents: false,
		columns: 100,
	});
	expect(terminal.text()).toContain("No subagents yet.");
	terminal.input("\r");
	const usage = {
		...response("").usage,
		input: 20_000,
		output: 5000,
		cacheRead: 15_000,
		cacheWrite: 10_000,
		totalTokens: 50_000,
	};
	const context = await spawnContext(
		stream((context) =>
			lastText(context) === "monitor"
				? { ...toolCall("blocking", {}), usage }
				: response(lastText(context), {
						usage: { ...usage, input: 31_000, totalTokens: 61_000 },
					}),
		),
	);
	const release = await blockingTool(context);
	const result = tree.start(ROOT, "monitor", context).result;
	terminal.input("\r"); // Opens the first arriving child.
	expect(header()).toContain("Subagent 1 · 1/1 · running · ctx ?");
	await until(() => tree.get("1")?.liveTools.size === 1);
	expect(header()).toContain("ctx 50k/100k (50.0%)");
	// Pending steering is not finalized model context yet.
	await tree.send("1", "next message");
	expect(header()).toContain("ctx 50k/100k (50.0%)");
	release.resolve();
	await result;
	expect(header()).toContain("ctx 61k/100k (61.0%)");
	await tree.send("1", "resume");
	// Two requests are billed, but context is the latest request, not their sum.
	expect(
		tree.get("1")?.session?.getSessionStats().tokens.total,
	).toBeGreaterThan(100_000);
	expect(header()).toContain("ctx 61k/100k (61.0%)");
	for (const parent of ["1", "1.1"])
		await tree.start(parent, "a very long task ".repeat(20), context).result;
	terminal.input(left);
	terminal.input(left);
	const rows = terminal.screen();
	expect(rows.find((line) => line.includes("1 [done]"))).toEndWith("61.0%");
	// Long instructions never push a nested row's context column out.
	expect(rows.find((line) => line.includes("1.1.1 [done]"))).toEndWith("61.0%");
});

test("closing unsubscribes at once, and cleanup is idempotent", async () => {
	const { tree, terminal, switcher, done } = await setup();
	terminal.input("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
	expect(terminal.text()).toContain("ROOT_TRANSCRIPT");
	const renders = spyRenders(terminal.tui);
	await tree.send("1", "continues after closing the switcher");
	expect(renders).not.toHaveBeenCalled();
	switcher.dispose();
	switcher.handleInput("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
});
