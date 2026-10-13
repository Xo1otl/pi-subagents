import { expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	getSelectListTheme,
	type KeybindingsManager,
	SessionManager,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	type EditorComponent,
	isFocusable,
	matchesKey,
	type TUI,
} from "@earendil-works/pi-tui";
import type { SubagentSwitcher } from "../ui/switcher.ts";
import {
	lastText,
	response,
	spawnContext,
	stream,
	testProvider,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

test("a real root extension keeps the indicator independent of overlays and clears it on reload", async () => {
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
		if (lastText(context).startsWith("Subagent "))
			return response("completion accepted");
		const text = lastText(context);
		if (text === "delegate")
			return toolCall("subagent", { instructions: "nested" });
		if (text === "nested")
			return toolCall("subagent", { instructions: "wait" });
		return waiting(options?.signal);
	});
	const context = await spawnContext(dispatch);
	const { cwd, agentDir, modelRuntime, model } = context;
	if (!agentDir) throw new Error("Missing agent directory");
	// Child sessions discover their provider through pi's real extension loader.
	const name = `pi-subagents.test-ui.${crypto.randomUUID()}`;
	const key = Symbol.for(name);
	const shared = globalThis as typeof globalThis & { [key]?: Provider };
	shared[key] = testProvider(dispatch);
	await mkdir(join(agentDir, "extensions"));
	await writeFile(
		join(agentDir, "extensions", "provider.js"),
		`export default function(pi) { pi.registerProvider(globalThis[Symbol.for("${name}")]); }`,
	);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		additionalExtensionPaths: [
			new URL("../index.ts", import.meta.url).pathname,
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const theme = { fg: (_color: string, text: string) => text } as Theme;
	const tui = { requestRender() {}, terminal: { rows: 24 } } as TUI;
	const keybindings = {
		matches(data: string, action: string) {
			if (action === "app.interrupt") return matchesKey(data, "escape");
			if (action === "tui.input.submit") return matchesKey(data, "enter");
			return false;
		},
	} as KeybindingsManager;
	const widgets = new Map<string, Component>();
	const editorTheme = {
		borderColor: (text: string) => text,
		selectList: getSelectListTheme(),
	};
	let editor: EditorComponent = new CustomEditor(tui, editorTheme, keybindings);
	let editorFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
	const getEditorComponent = () => editorFactory;
	const setEditorComponent = (factory: typeof editorFactory) => {
		const text = editor.getText();
		editorFactory = factory;
		editor =
			factory?.(tui, editorTheme, keybindings) ??
			new CustomEditor(tui, editorTheme, keybindings);
		editor.setText(text);
		if (isFocusable(editor)) editor.focused = true;
	};
	let switcher: SubagentSwitcher | undefined;
	const custom = mock(
		async (
			factory: Parameters<ExtensionUIContext["custom"]>[0],
			_options?: Parameters<ExtensionUIContext["custom"]>[1],
		) => {
			let done = (_result: unknown) => {};
			const completed = new Promise<unknown>((resolve) => {
				done = resolve;
			});
			if (isFocusable(editor)) editor.focused = false;
			const component = await factory(tui, theme, keybindings, done);
			switcher = component as SubagentSwitcher;
			switcher.focused = true;
			await completed;
			component.dispose?.();
			switcher = undefined;
			if (isFocusable(editor)) editor.focused = true;
		},
	);
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
	try {
		await session.bindExtensions({ mode: "tui", uiContext: ui });
		expect(getEditorComponent()).toBeDefined();
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[D");
		expect(custom).not.toHaveBeenCalled();
		expect(switcher).toBeUndefined();
		const run = session.prompt("delegate");
		await until(() => indicator().includes("2 running"));
		expect(indicator()).toContain("1, 1.1");
		const open = session.prompt("/subagents 1.1");
		await until(() => Boolean(switcher));
		expect(switcher?.render(80)[1]).toContain("Subagents · 1.1");
		expect(custom.mock.calls[0]?.[1]).toEqual({
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				margin: 0,
			},
		});
		switcher?.handleInput("\x1b");
		await open;
		expect(indicator()).toContain("2 running");
		// Cursor-moving Left presses stay in the editor. At the text start, the
		// chord opens the tree while the root is running without losing the draft.
		const terminalInput = (data: string) => {
			if (switcher) switcher.handleInput(data);
			else editor.handleInput(data);
		};
		editor.setText("root draft");
		terminalInput("\x1b[D");
		expect(switcher).toBeUndefined();
		terminalInput("\x1b[D");
		expect(custom).toHaveBeenCalledTimes(1);
		expect(switcher).toBeUndefined();
		terminalInput("X");
		expect(editor.getText()).toBe("root draXft");
		terminalInput("\x01"); // Ctrl+A moves to the beginning.
		terminalInput("\x1b[D");
		expect(custom).toHaveBeenCalledTimes(1);
		terminalInput("\x1b[D");
		await until(() => Boolean(switcher));
		expect(editor.getText()).toBe("root draXft");
		expect(switcher?.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		terminalInput("\x1b[D");
		terminalInput("\x1b[B");
		expect(switcher?.render(80)[1]).toContain("Subagents · 1.1");
		expect(custom).toHaveBeenCalledTimes(2);
		switcher?.handleInput("\x1b");
		await until(() => !switcher);
		await session.abort();
		await run;
		// Background jobs outlive the root turn. Stop them explicitly in the switcher.
		expect(indicator()).toContain("2 running");
		const stopping = session.prompt("/subagents 1");
		await until(() => Boolean(switcher));
		switcher?.handleInput("\x03");
		await until(() => widgets.size === 0);
		switcher?.handleInput("\x1b");
		await stopping;

		// Restart a completed descendant from the overlay while the root stays idle.
		const reopened = session.prompt("/subagents 1.1");
		await until(() => Boolean(switcher));
		switcher?.handleInput("wait again");
		switcher?.handleInput("\r");
		await until(() => indicator().includes("1 running · 1.1"));
		expect(session.isStreaming).toBe(false);
		switcher?.handleInput("\x1b");
		await reopened;
		expect(indicator()).toContain("1 running · 1.1");
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
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[D");
		expect(custom).not.toHaveBeenCalled();
		expect(switcher).toBeUndefined();
	} finally {
		await session.abort();
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		expect(getEditorComponent()).toBeUndefined();
		session.dispose();
		delete shared[key];
	}
});
