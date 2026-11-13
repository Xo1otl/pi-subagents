import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "../runtime/index.ts";
import { createSubagentSwitcher } from "../ui/switcher.ts";
import {
	fullscreen,
	onCleanup,
	response,
	spawnContext,
	stream,
	testRuntime,
	toolCall,
	until,
} from "./fixtures.ts";

const theme = { fg: (_color: string, text: string) => text };

/** A switcher showing agent 1's chat; `agents` completed agents exist up front. */
async function setup(agents = 2) {
	const tree = testRuntime();
	const context = await spawnContext();
	for (let i = 0; i < agents; i++)
		await tree.start(ROOT, `task ${i + 1}`, context).result;
	const terminal = fullscreen({ columns: 80 });
	const switcher = createSubagentSwitcher({
		runtime: tree,
		tui: terminal.tui,
		theme,
		keybindings: terminal.keybindings,
		onClose() {},
		initialId: "1",
	});
	onCleanup(() => switcher.dispose());
	terminal.mount(switcher);
	const header = () => terminal.screen()[0] ?? "";
	/** The transcript rows, between the header and the composer. */
	const transcript = () => {
		const lines = terminal.screen();
		return lines.slice(
			1,
			lines.findIndex((line) => line.includes("Message this")),
		);
	};
	return { tree, terminal, header, transcript };
}

test("history stays in place while output arrives; reaching the end or Ctrl+End follows live output again", async () => {
	const { tree, terminal, header, transcript } = await setup();
	await tree.send(
		"1",
		Array.from({ length: 80 }, (_, i) => `history ${i}`).join("\n"),
	);
	expect(header()).toEndWith(" · live");
	expect(transcript().at(-1)).toBe("history 79");
	terminal.input("\x1b[5~"); // PageUp
	const paused = transcript();
	expect(paused.at(-1)).toMatch(/^history \d+$/);
	expect(paused.at(-1)).not.toBe("history 79");
	const below = Number(/↓(\d+)$/.exec(header())?.[1]);
	expect(below).toBeGreaterThan(0);
	await tree.get("1")?.session?.sendCustomMessage({
		customType: "incoming",
		display: true,
		content: Array.from({ length: 30 }, (_, i) => `arrival ${i}`).join("\n"),
	});
	expect(transcript()).toEqual(paused);
	expect(header()).toEndWith(`↓${below + 32}`);
	terminal.input("\t");
	terminal.input("\x1b[Z"); // Each agent keeps its own position.
	expect(transcript()).toEqual(paused);
	terminal.mouse(64, 10, 5); // Wheel up one line.
	expect(transcript().slice(1)).toEqual(paused.slice(0, -1));
	terminal.input("\x1b[1;5H"); // Ctrl+Home
	expect(transcript()[0]).toBe("user");
	terminal.input("\x1b[1;5F"); // Ctrl+End
	expect(transcript().at(-1)).toBe("arrival 29");
	expect(header()).toEndWith(" · live");
	terminal.input("\x1b[5~");
	terminal.input("\x1b[6~"); // Paging back to the end resumes following.
	expect(header()).toEndWith(" · live");
	await tree.get("1")?.session?.sendCustomMessage({
		customType: "incoming",
		display: true,
		content: "latest arrival",
	});
	expect(transcript().at(-1)).toBe("latest arrival");
});

test("a real bash tool streams logs before exit; clicking its header toggles it in place; Ctrl+O expands every tool", async () => {
	const { tree, terminal, header, transcript } = await setup(0);
	const context = await spawnContext(
		stream((transcript) =>
			transcript.messages.at(-1)?.role === "toolResult"
				? response("command finished")
				: call,
		),
	);
	const gate = join(context.cwd, "release-command");
	const release = () => writeFile(gate, "release");
	onCleanup(release);
	const command = `printf 'FIRST_LOG\\n'; while [ ! -f '${gate}' ]; do sleep 0.01; done; printf 'LAST_LOG\\n'`;
	const intro = Array.from({ length: 30 }, (_, i) => `intro ${i}`).join("\n");
	const call = toolCall("bash", { command });
	call.content.unshift({ type: "thinking", thinking: "PRIVATE_THINKING" });
	call.content.unshift({ type: "text", text: intro });
	const result = tree.start(ROOT, "run slow command", context).result;
	const text = () => terminal.text();
	await until(() =>
		[...(tree.get("1")?.liveTools.values() ?? [])].some((tool) =>
			tool.result?.content.some(
				(part) => part.type === "text" && part.text.includes("FIRST_LOG"),
			),
		),
	);
	expect(tree.get("1")?.status).toBe("running");
	expect(text()).toContain("FIRST_LOG");
	expect(text()).not.toContain("LAST_LOG");
	const row = terminal.row("▸ bash [running]");
	terminal.click(2, row);
	// The expanded header holds its row instead of following the end.
	expect(terminal.row("▾ bash [running]")).toBe(row);
	expect(header()).toMatch(/↓[1-9]\d*$/);
	expect(text()).toContain('"command":');
	await release();
	expect((await result).status).toBe("done");
	terminal.input("\x1b[1;5F");
	expect(text()).toContain("LAST_LOG");
	terminal.click(2, terminal.row("▾ bash [done]"));
	expect(text()).toContain("▸ bash [done]");
	terminal.input("\x0f"); // Ctrl+O expands every tool, not thinking.
	expect(text()).toContain("▾ bash [done]");
	expect(text()).not.toContain("PRIVATE_THINKING");
	terminal.input("\x14"); // Ctrl+T shows thinking.
	expect(transcript()).toContain("PRIVATE_THINKING");
	expect(text()).toContain("▾ bash [done]");
});

test("a late send failure stays with its own agent and keeps the message", async () => {
	const { tree, terminal, header } = await setup();
	const send = Promise.withResolvers<void>();
	tree.send = () => send.promise;
	terminal.input("message");
	terminal.input("\r");
	terminal.input("\t");
	send.reject(new Error("late send failure"));
	await send.promise.catch(() => {});
	expect(terminal.text()).not.toContain("late send failure");
	terminal.input("\x1b[Z");
	expect(header()).toContain("late send failure");
	expect(terminal.screen()[terminal.row("Message this") + 1]).toBe("message");
});
