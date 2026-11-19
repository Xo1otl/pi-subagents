import { expect, mock, spyOn, test } from "bun:test";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { ROOT } from "../runtime/index.ts";
import { createSubagentSwitcher } from "../ui/switcher.ts";
import {
	blockingTool,
	chatting,
	fullscreen,
	hasRunningTool,
	lastText,
	onCleanup,
	paused,
	report,
	response,
	spawnContext,
	stream,
	testRuntime,
	theme,
	toolCall,
	until,
} from "./fixtures.ts";

const left = "\x1b[D";

async function setup({
	agents = true,
	initialId,
	columns = 80,
}: {
	agents?: boolean;
	initialId?: string;
	columns?: number;
} = {}) {
	const tree = testRuntime();
	if (agents) {
		await tree.start(ROOT, "nest:1", await spawnContext()).result;
		await tree.start(ROOT, "other", await spawnContext()).result;
	}
	const terminal = fullscreen({ columns });
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
	onCleanup(() => switcher.dispose());
	overlay = terminal.mount(switcher);
	const header = () =>
		terminal.screen().find((line) => line.startsWith("Subagent")) ?? "";
	const composer = () => {
		const lines = terminal.screen();
		const top = lines.findIndex((line) => line.includes("Message this"));
		return lines.slice(top + 1, -2).join("\n");
	};
	return { tree, terminal, switcher, done, header, composer };
}

test("the compact picker lists every descendant's status, task and context below the root, and arrows walk the tree", async () => {
	const { terminal } = await setup();
	const lines = terminal.screen();
	expect(lines).toHaveLength(24);
	expect(lines[0]).toContain("ROOT_TRANSCRIPT");
	expect(lines.slice(-6)).toEqual([
		expect.stringMatching(/^─+$/),
		expect.stringMatching(/^Subagents\b.*\b3\b/),
		expect.stringMatching(/^> 1 \[done\] nest:1 +0\.0%$/),
		expect.stringMatching(/^ {4}1\.1 \[done\] nest:0 +\d/),
		expect.stringMatching(/^ {2}2 \[done\] other/),
		expect.stringContaining("Enter open"),
	]);
	expect(terminal.cursor()).toBeUndefined();
	const selected = () => terminal.screen().find((line) => line.startsWith(">"));
	terminal.input("\x1b[A");
	expect(selected()).toStartWith("> 1 [");
	terminal.input("\x1b[C");
	expect(selected()).toStartWith(">   1.1 [");
	terminal.input(left);
	expect(selected()).toStartWith("> 1 [");
	terminal.input(left);
	expect(selected()).toStartWith("> 1 [");
	for (let i = 0; i < 3; i++) terminal.input("\x1b[B");
	expect(selected()).toStartWith("> 2 [");
	terminal.input("\x1b[C");
	expect(terminal.screen()[0]).toContain("Subagent 2 · 3/3 · done · ctx");
	expect(terminal.text()).not.toContain("ROOT_TRANSCRIPT");
	expect(terminal.cursor()).toEqual({
		row: terminal.row("Message this subagent") + 1,
		col: 0,
	});
});

test("clicks open agents and place the composer cursor without taking focus; wheels never scroll pi's screen beneath", async () => {
	const { terminal, switcher, header } = await setup();
	terminal.mouse(64, 10, terminal.row("  2 [done]"));
	expect(terminal.tui.isFollowingOutput).toBe(true);
	terminal.click(4, terminal.row("  2 [done]"));
	expect(header()).toContain("Subagent 2");
	terminal.input("message after clicking");
	terminal.click(0, terminal.row("message after clicking"));
	terminal.input("X");
	expect(terminal.text()).toContain("Xmessage after clicking");
	expect(terminal.tui.getFocusedComponent()).toBe(switcher);
	terminal.mouse(64, 10, 5);
	expect(terminal.tui.isFollowingOutput).toBe(true);
});

test("each agent keeps its draft, undo and history across Tab and the picker; Enter sends to the selected child", async () => {
	const { tree, terminal, header, composer } = await setup({ initialId: "1" });
	const messages = (id: string) =>
		JSON.stringify(tree.get(id)?.session?.messages);
	terminal.input("alpha");
	terminal.input("\n");
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
	terminal.input("\t");
	expect(composer()).toContain("alpha\nbeta");
	terminal.input(left);
	terminal.input("X");
	expect(composer()).toContain("alpha\nbetXa");
	terminal.input("\x1b[45;5u");
	expect(composer()).toContain("alpha\nbeta");
	terminal.input("\x1b[Z");
	expect(header()).toContain("Subagent 2");
	terminal.input(left);
	terminal.input(left);
	expect(header()).toContain("Subagents · 3");
	terminal.input("\x1b[A");
	terminal.input("\r");
	expect(header()).toContain("Subagent 1.1");
	expect(composer()).toContain("leaf draft");
	terminal.input("\x15");
	terminal.input("\x1b[A");
	expect(composer()).toContain("message the leaf");
	terminal.input("\x1b[Z");
	terminal.input("\r");
	await until(() => messages("1").includes("alpha\\nbeta"));
});

test("Left twice at the text start returns to the picker; nothing inside a bracketed paste is a shortcut", async () => {
	const { tree, terminal, done, header, composer } = await setup({
		initialId: "1",
	});
	const sent = mock(() => {});
	tree.subscribe(sent);
	for (const chunk of ["\x1b[200~", left, left, "\t", "\x1b", "\x1b[201~"])
		terminal.input(chunk);
	expect(done).not.toHaveBeenCalled();
	expect(header()).toContain("Subagent 1 ");
	expect(composer()).toContain("[D[D");
	terminal.input("\x15");
	terminal.input("\x1b[200~first\nsecond\x1b[201~");
	for (let i = 0; i < "first\nsecond".length; i++) terminal.input(left);
	expect(header()).toContain("Subagent 1 ");
	terminal.input(left);
	terminal.input("\x1b[200~\x1b[201~");
	terminal.input(left);
	terminal.input("\t");
	terminal.input("\x1b[Z");
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
	const context = await spawnContext(paused);
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

test("Ctrl+C interrupts a turn, returning queued input to the draft; pressed again, it stops the agent", async () => {
	const { tree, terminal, composer, header } = await setup({
		agents: false,
		initialId: "1",
		columns: 200,
	});
	const context = await spawnContext(
		stream((context) =>
			lastText(context) === "monitor"
				? toolCall("blocking", {})
				: response(lastText(context)),
		),
	);
	const blocking = await blockingTool(context);
	const result = tree.start(ROOT, "monitor", context).result;
	await blocking.reached;
	expect(hasRunningTool(tree.get("1"))).toBe(true);
	expect(terminal.text()).toContain("Ctrl+C interrupt");
	terminal.input("QUEUED_MESSAGE");
	terminal.input("\r");
	await until(() => tree.get("1")?.queuedInput.length === 1);
	expect(terminal.text()).toContain("queued");
	expect(terminal.text()).toContain("QUEUED_MESSAGE");
	terminal.input("newer draft");
	terminal.input("\x03");
	expect(composer()).toContain("QUEUED_MESSAGE\n\nnewer draft");
	expect(terminal.text()).not.toContain("queued");
	await tree.settled("1");
	await tree.get("1")?.session?.waitForIdle();
	expect(header()).toContain("Subagent 1 · 1/1 · interrupted");
	expect(terminal.text()).toContain("Ctrl+C stop");
	expect(Bun.peek.status(result)).toBe("pending");
	terminal.input("\x03");
	expect((await result).status).toBe("aborted");
	expect(composer()).toContain("QUEUED_MESSAGE\n\nnewer draft");
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
		stream((context) => {
			if (lastText(context) === "monitor")
				return { ...toolCall("blocking", {}), usage };
			const overrides = {
				usage: { ...usage, input: 31_000, totalTokens: 61_000 },
			};
			return chatting(context)
				? response(lastText(context), overrides)
				: report(lastText(context), overrides);
		}),
	);
	const release = await blockingTool(context);
	const result = tree.start(ROOT, "monitor", context).result;
	terminal.input("\r");
	expect(header()).toContain("Subagent 1 · 1/1 · running · ctx ?");
	await until(() => tree.get("1")?.liveTools.size === 1);
	expect(header()).toContain("ctx 50k/100k (50.0%)");
	await tree.send("1", "next message");
	expect(header()).toContain("ctx 50k/100k (50.0%)");
	release.open();
	await result;
	expect(header()).toContain("ctx 61k/100k (61.0%)");
	await tree.send("1", "resume");
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
	expect(rows.find((line) => line.includes("1.1.1 [done]"))).toEndWith("61.0%");
});

test("closing unsubscribes at once, and cleanup is idempotent", async () => {
	const { tree, terminal, switcher, done } = await setup();
	terminal.input("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
	expect(terminal.text()).toContain("ROOT_TRANSCRIPT");
	const renders = spyOn(terminal.tui, "requestRender");
	await tree.send("1", "continues after closing the switcher");
	expect(renders).not.toHaveBeenCalled();
	switcher.dispose();
	switcher.handleInput("\x1b");
	expect(done).toHaveBeenCalledTimes(1);
});
