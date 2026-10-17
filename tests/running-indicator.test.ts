import { afterEach, expect, mock, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSubagentRuntime } from "../agent/index.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import { createSubagentUI } from "../ui/index.ts";
import { bindRunningIndicator } from "../ui/running-indicator.ts";
import {
	lastText,
	spawnContext,
	stream,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

const runtimes: Subagents[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) dispose();
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

type Widget = string[] | ((tui: TUI, theme: Theme) => Component);
const theme = { fg: (_color: string, text: string) => text } as Theme;
const paused = stream((_context, options) => waiting(options?.signal));

function setup(bind = true) {
	const runtime = createSubagentRuntime();
	runtimes.push(runtime);
	const widgets = new Map<string, Widget>();
	const setWidget = mock((key: string, content: Widget | undefined) => {
		if (content) widgets.set(key, content);
		else widgets.delete(key);
	});
	let editorFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
	const getEditorComponent = () => editorFactory;
	const setEditorComponent = mock((factory: typeof editorFactory) => {
		editorFactory = factory;
	});
	const ui: Pick<
		ExtensionUIContext,
		"setWidget" | "getEditorComponent" | "setEditorComponent"
	> = { setWidget, getEditorComponent, setEditorComponent };
	const dispose = bind ? bindRunningIndicator(runtime, ui) : () => {};
	disposers.push(dispose);
	const render = (width = 100, currentTheme = theme) =>
		[...widgets.values()]
			.flatMap((widget) =>
				typeof widget === "function"
					? widget({} as TUI, currentTheme).render(width)
					: widget,
			)
			.join("\n");
	return {
		runtime,
		ui,
		setWidget,
		setEditorComponent,
		widgets,
		dispose,
		render,
	};
}

test("counts concurrent runs from startup through stopping and settlement, bounded to the terminal width", async () => {
	const { runtime, setWidget, widgets, render } = setup();
	expect(setWidget).not.toHaveBeenCalled();
	const context = await spawnContext(paused);
	const runs = Array.from(
		{ length: 5 },
		(_, i) => runtime.start(ROOT, `run ${i}`, context).result,
	);
	expect(render()).toBe(
		"● Subagents: 5 running · 1, 2, 3, … · ←← / Ctrl+Shift+A to view",
	);
	setWidget.mockClear();
	await until(() =>
		runtime.tree().every((node) => Boolean(node.session?.isStreaming)),
	);
	// Session creation and streamed events do not reinstall an unchanged summary.
	expect(setWidget).not.toHaveBeenCalled();
	for (const width of [1, 5, 20])
		expect(visibleWidth(render(width))).toBeLessThanOrEqual(width);
	// The active theme is evaluated at render time.
	const upper = { fg: (_color: string, text: string) => text.toUpperCase() };
	expect(render(100, upper as Theme)).toContain("SUBAGENTS: 5 RUNNING");
	runtime.abort("1");
	expect(render()).toContain("4 running · 1 stopping · 1, 2, 3, …");
	await runs[0];
	expect(render()).toContain("Subagents: 4 running · 2, 3, 4, …");
	runtime.abort();
	await Promise.all(runs);
	expect(widgets.size).toBe(0);
});

test("includes nested agents and conversations restarted while the root is idle", async () => {
	const { runtime, render, widgets } = setup();
	const context = await spawnContext(
		stream((context, options) =>
			lastText(context) === "parent"
				? toolCall("subagent", { instructions: "wait" })
				: waiting(options?.signal),
		),
	);
	const parent = runtime.start(ROOT, "parent", context).result;
	await until(() => Boolean(runtime.get("1.1")?.session?.isStreaming));
	expect(render()).toContain("Subagents: 2 running · 1, 1.1");
	runtime.abort();
	await parent;
	expect(widgets.size).toBe(0);
	const restarted = runtime.send("1.1", "wait again");
	await until(() => Boolean(runtime.get("1.1")?.session?.isStreaming));
	expect(runtime.get("1")?.status).toBe("aborted");
	expect(render()).toContain("Subagents: 1 running · 1.1");
	runtime.abort("1.1");
	await restarted;
	expect(widgets.size).toBe(0);
});

test("disposal is idempotent, late updates touch no widget, and runtime shutdown clears it at once", async () => {
	const { runtime, widgets, setWidget, dispose, render } = setup();
	widgets.set("another-extension", ["unrelated widget"]);
	const context = await spawnContext(paused);
	const run = runtime.start(ROOT, "wait", context).result;
	expect(render()).toContain("Subagents: 1 running");
	dispose();
	dispose();
	expect(render()).toBe("unrelated widget");
	setWidget.mockClear();
	runtime.abort();
	await run;
	expect(setWidget).not.toHaveBeenCalled();

	const next = setup();
	const running = next.runtime.start(ROOT, "wait", context).result;
	expect(next.widgets.size).toBe(1);
	const closing = next.runtime.dispose();
	expect(next.widgets.size).toBe(0);
	await closing;
	await running;
});

test("UI bindings are terminal-only, and rebinding or disposal removes the old runtime's widget and editor", async () => {
	const { runtime, ui, setWidget, setEditorComponent, render } = setup(false);
	const controller = createSubagentUI({
		registerMessageRenderer() {},
		registerCommand() {},
		registerShortcut() {},
	} as unknown as ExtensionAPI);
	disposers.push(controller.dispose);
	for (const mode of ["print", "json", "rpc"] as const)
		controller.bind(runtime, { mode, ui } as ExtensionContext);
	const run = runtime.start(ROOT, "wait", await spawnContext(paused)).result;
	expect(setWidget).not.toHaveBeenCalled();
	expect(setEditorComponent).not.toHaveBeenCalled();
	controller.bind(runtime, { mode: "tui", ui } as ExtensionContext);
	const firstFactory = ui.getEditorComponent();
	expect(firstFactory).toBeDefined();
	expect(render()).toContain("Subagents: 1 running");
	const next = createSubagentRuntime();
	runtimes.push(next);
	controller.bind(next, { mode: "tui", ui } as ExtensionContext);
	expect(ui.getEditorComponent()).toBeDefined();
	expect(ui.getEditorComponent()).not.toBe(firstFactory);
	expect(render()).toBe("");
	setWidget.mockClear();
	runtime.abort();
	await run;
	expect(setWidget).not.toHaveBeenCalled();
	controller.dispose();
	controller.dispose();
	expect(ui.getEditorComponent()).toBeUndefined();
	expect(setEditorComponent).toHaveBeenCalledTimes(4);
});
