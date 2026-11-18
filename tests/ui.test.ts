import { expect, mock, test } from "bun:test";
import {
	CustomEditor,
	type ExtensionUIContext,
	getSelectListTheme,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	EditorComponent,
	OverlayHandle,
	TUI,
} from "@earendil-works/pi-tui";
import { SUBAGENT_RESULT_TYPE } from "../agent/protocol.ts";
import extension from "../index.ts";
import { SWITCHER_OVERLAY } from "../ui/switcher.ts";
import {
	fullscreen,
	lastCustomMessage,
	lastText,
	onCleanup,
	parentSession,
	response,
	stream,
	taskText,
	theme,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

type Custom = ExtensionUIContext["custom"];
type EditorFactory = ReturnType<ExtensionUIContext["getEditorComponent"]>;

const left = "\x1b[D";

const dispatch = stream((context, options) => {
	if (context.messages.at(-1)?.role === "toolResult")
		return taskText(context) === "delegate"
			? waiting(options?.signal)
			: response(lastText(context));
	if (lastCustomMessage(context, SUBAGENT_RESULT_TYPE))
		return response("completion accepted");
	const text = lastText(context);
	if (text === "delegate")
		return toolCall("subagent", { instructions: "nested" });
	if (text === "nested") return toolCall("subagent", { instructions: "wait" });
	return waiting(options?.signal);
});

async function interactive() {
	const session = await parentSession({
		streamFn: dispatch,
		extensions: [extension],
	});
	onCleanup(() => session.abort());
	const terminal = fullscreen({ columns: 80 });
	const { tui } = terminal;
	const keybindings = terminal.keybindings as KeybindingsManager;
	const editorTheme = {
		borderColor: (text: string) => text,
		selectList: getSelectListTheme(),
	};
	let editor: EditorComponent = new CustomEditor(tui, editorTheme, keybindings);
	tui.addChild(editor);
	tui.setFocus(editor);
	let editorFactory: EditorFactory;
	let switcher: Component | undefined;
	const custom = mock(
		(factory: Parameters<Custom>[0], options?: Parameters<Custom>[1]) =>
			new Promise<unknown>((resolve) => {
				let overlay: OverlayHandle | undefined;
				const component = factory(tui, theme, keybindings, (result) => {
					overlay?.hide();
					switcher = undefined;
					resolve(result);
				}) as Component;
				const overlayOptions = options?.overlayOptions;
				overlay = tui.showOverlay(
					component,
					typeof overlayOptions === "function"
						? overlayOptions()
						: overlayOptions,
				);
				switcher = component;
			}),
	);
	const widgets = new Map<string, Component>();
	const setWidget = mock(
		(
			key: string,
			factory: ((tui: TUI, theme: Theme) => Component) | undefined,
		) => {
			if (factory) widgets.set(key, factory(tui, theme));
			else widgets.delete(key);
		},
	);
	const ui = {
		custom,
		setWidget,
		getEditorComponent: () => editorFactory,
		setEditorComponent(factory: EditorFactory) {
			const text = editor.getText();
			editorFactory = factory;
			const next =
				factory?.(tui, editorTheme, keybindings) ??
				new CustomEditor(tui, editorTheme, keybindings);
			tui.removeChild(editor);
			tui.addChild(next);
			editor = next;
			editor.setText(text);
			tui.setFocus(editor);
		},
		notify() {},
	} as unknown as ExtensionUIContext;
	return {
		session,
		terminal,
		custom,
		setWidget,
		widgets,
		editor: () => editor,
		editorFactory: () => editorFactory,
		switcherOpen: () => switcher !== undefined,
		bind: () => session.bindExtensions({ mode: "tui", uiContext: ui }),
		indicator: () =>
			[...widgets.values()].flatMap((widget) => widget.render(100)).join("\n"),
		header: () =>
			terminal.screen().find((line) => line.startsWith("Subagent")) ?? "",
	};
}

test("the root opens the switcher from /subagents and from Left-Left at its editor's text start, during and after its own run", async () => {
	const { session, terminal, custom, widgets, editor, ...ui } =
		await interactive();
	const rootEditor = editor();
	await ui.bind();
	expect(editor()).toBe(rootEditor);
	terminal.input(left);
	terminal.input(left);
	expect(custom).not.toHaveBeenCalled();
	const run = session.prompt("delegate");
	await until(() => ui.indicator().includes("2 running"));
	expect(ui.indicator()).toContain("1, 1.1");

	const open = session.prompt("/subagents 1.1");
	await until(ui.switcherOpen);
	expect(custom.mock.calls[0]?.[1]).toEqual({
		overlay: true,
		overlayOptions: SWITCHER_OVERLAY,
	});
	expect(ui.header()).toContain("Subagent 1.1");
	terminal.input("\x1b");
	await open;
	expect(terminal.text()).toContain("ROOT_TRANSCRIPT");

	editor().setText("root draft");
	terminal.input("\x01");
	terminal.input(left);
	terminal.input(left);
	await until(ui.switcherOpen);
	expect(editor().getText()).toBe("root draft");
	expect(ui.header()).toContain("Subagents · 2");
	terminal.input("\x1b");
	await until(() => !ui.switcherOpen());
	expect(terminal.tui.getFocusedComponent()).toBe(editor());

	await session.abort();
	await run;
	expect(ui.indicator()).toContain("2 running");
	const stopping = session.prompt("/subagents 1");
	await until(ui.switcherOpen);
	terminal.input("\x03");
	await until(() => widgets.size === 0);
	terminal.input("\x1b");
	await stopping;
});

test("reload releases the indicator and the editor of running subagents; a rebound root starts empty, and quitting releases it too", async () => {
	const { session, terminal, custom, setWidget, widgets, ...ui } =
		await interactive();
	await ui.bind();
	const run = session.prompt("delegate");
	await until(() => ui.indicator().includes("2 running"));
	await session.abort();
	await run;
	expect(widgets.size).toBe(1);

	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "reload",
	});
	expect(widgets.size).toBe(0);
	expect(ui.editorFactory()).toBeUndefined();

	setWidget.mockClear();
	await ui.bind();
	expect(ui.editorFactory()).toBeDefined();
	expect(setWidget).not.toHaveBeenCalled();
	terminal.input(left);
	terminal.input(left);
	expect(custom).not.toHaveBeenCalled();

	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	expect(ui.editorFactory()).toBeUndefined();
});
