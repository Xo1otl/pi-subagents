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
	parentSession,
	response,
	stream,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

type Custom = ExtensionUIContext["custom"];

test("a real root extension opens the switcher overlay from commands and the root editor, and cleans up on reload", async () => {
	const dispatch = stream((context, options) => {
		if (context.messages.at(-1)?.role === "toolResult") {
			const root = context.messages.some(
				(message) =>
					message.role === "user" &&
					(typeof message.content === "string"
						? message.content === "delegate"
						: message.content.some(
								(part) => part.type === "text" && part.text === "delegate",
							)),
			);
			return root ? waiting(options?.signal) : response(lastText(context));
		}
		if (lastCustomMessage(context, SUBAGENT_RESULT_TYPE))
			return response("completion accepted");
		const text = lastText(context);
		if (text === "delegate")
			return toolCall("subagent", { instructions: "nested" });
		if (text === "nested")
			return toolCall("subagent", { instructions: "wait" });
		return waiting(options?.signal);
	});
	const session = await parentSession(dispatch, [extension]);
	const theme = { fg: (_color: string, text: string) => text } as Theme;
	const terminal = fullscreen({ columns: 80 });
	const tui = terminal.tui;
	const keybindings = terminal.keybindings as KeybindingsManager;
	const editorTheme = {
		borderColor: (text: string) => text,
		selectList: getSelectListTheme(),
	};
	// Like pi's interactive mode: a focused root editor that extensions may replace.
	let editor: EditorComponent = new CustomEditor(tui, editorTheme, keybindings);
	tui.addChild(editor);
	tui.setFocus(editor);
	let editorFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
	const getEditorComponent = () => editorFactory;
	const setEditorComponent = (factory: typeof editorFactory) => {
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
	};
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
		getEditorComponent,
		setEditorComponent,
		notify() {},
	} as unknown as ExtensionUIContext;
	const indicator = () =>
		[...widgets.values()].flatMap((widget) => widget.render(100)).join("\n");
	const header = () =>
		terminal.screen().find((line) => line.startsWith("Subagent")) ?? "";
	const left = "\x1b[D";
	try {
		const rootEditor = editor;
		await session.bindExtensions({ mode: "tui", uiContext: ui });
		expect(editor).toBe(rootEditor);
		expect(getEditorComponent()).toBeDefined();
		terminal.input(left);
		terminal.input(left);
		expect(custom).not.toHaveBeenCalled();
		const run = session.prompt("delegate");
		await until(() => indicator().includes("2 running"));
		expect(indicator()).toContain("1, 1.1");
		const open = session.prompt("/subagents 1.1");
		await until(() => Boolean(switcher));
		expect(custom.mock.calls[0]?.[1]).toEqual({
			overlay: true,
			overlayOptions: SWITCHER_OVERLAY,
		});
		expect(header()).toContain("Subagent 1.1");
		terminal.input("\x1b");
		await open;
		expect(terminal.text()).toContain("ROOT_TRANSCRIPT");
		expect(indicator()).toContain("2 running");
		// The root chord opens the picker during a run without losing its draft.
		editor.setText("root draft");
		terminal.input("\x01");
		terminal.input(left);
		terminal.input(left);
		await until(() => Boolean(switcher));
		expect(editor.getText()).toBe("root draft");
		expect(header()).toContain("Subagents · 2");
		expect(custom).toHaveBeenCalledTimes(2);
		terminal.input("\x1b");
		await until(() => !switcher);
		expect(tui.getFocusedComponent()).toBe(editor);
		await session.abort();
		await run;
		// Background jobs outlive the root turn. Stop them explicitly in the switcher.
		expect(indicator()).toContain("2 running");
		const stopping = session.prompt("/subagents 1");
		await until(() => Boolean(switcher));
		terminal.input("\x03");
		await until(() => widgets.size === 0);
		terminal.input("\x1b");
		await stopping;

		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "reload",
		});
		expect(widgets.size).toBe(0);
		expect(getEditorComponent()).toBeUndefined();
		setWidget.mockClear();
		await session.bindExtensions({ mode: "tui", uiContext: ui });
		expect(getEditorComponent()).toBeDefined();
		expect(setWidget).not.toHaveBeenCalled();
		custom.mockClear();
		editor.setText("");
		terminal.input(left);
		terminal.input(left);
		expect(custom).not.toHaveBeenCalled();
	} finally {
		await session.abort();
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		expect(getEditorComponent()).toBeUndefined();
		session.dispose();
		terminal.stop();
	}
});
