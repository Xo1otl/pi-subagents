import { expect, mock, test } from "bun:test";
import {
	CustomEditor,
	type ExtensionUIContext,
	getSelectListTheme,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type EditorComponent,
	type EditorTheme,
	Input,
	type Terminal,
	type TUI,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import {
	atTextStart,
	bindDoubleLeftNavigation,
	createDoubleLeftDetector,
} from "../ui/navigation.ts";

const left = "\x1b[D";

test("detects two consecutive Left presses within 500ms without consuming the first", () => {
	const detector = createDoubleLeftDetector();
	expect(detector.matches(left, 0)).toBe(false);
	expect(detector.matches(left, 500)).toBe(true);
	expect(detector.matches(left, 501)).toBe(false);
	expect(detector.matches(left, 600)).toBe(true);
});

test("slow taps, other keys, modifiers and pasted text reset the chord", () => {
	const detector = createDoubleLeftDetector();
	expect(detector.matches(left, 0)).toBe(false);
	expect(detector.matches(left, 501)).toBe(false);
	for (const data of ["x", "\x1b[C", "\x1b[1;5D", "\x1b[200~\x1b[D\x1b[201~"]) {
		detector.reset();
		expect(detector.matches(left, 1000)).toBe(false);
		expect(detector.matches(data, 1100)).toBe(false);
		expect(detector.matches(left, 1200)).toBe(false);
		expect(detector.matches(left, 1300)).toBe(true);
	}
});

test("supports terminal key encodings and ignores Kitty releases and held-key repeats", () => {
	const detector = createDoubleLeftDetector();
	expect(detector.matches("\x1bOD", 0)).toBe(false);
	expect(detector.matches("\x1b[1;1:3D", 10)).toBe(false);
	expect(detector.matches("\x1b[1;1D", 100)).toBe(true);
	expect(detector.matches(left, 200)).toBe(false);
	expect(detector.matches("\x1b[1;1:2D", 210)).toBe(false);
	expect(detector.matches(left, 220)).toBe(false);
	detector.reset();
	expect(detector.matches(left, 300)).toBe(false);
});

type EditorFactory = ReturnType<ExtensionUIContext["getEditorComponent"]>;
const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: getSelectListTheme(),
};
const keybindings = { matches: () => false } as unknown as KeybindingsManager;

function editorUI(previous?: EditorFactory) {
	let current = previous;
	return {
		getEditorComponent: () => current,
		setEditorComponent: mock((factory: EditorFactory) => {
			current = factory;
		}),
	};
}

test("main navigation preserves an existing empty editor, passes single Left through and restores it on disposal", () => {
	const input = new Input();
	const forwarded = mock((data: string) => input.handleInput(data));
	const editor: EditorComponent = {
		handleInput: forwarded,
		getText: () => input.getValue(),
		setText: (text) => input.setValue(text),
		render: (width) => input.render(width),
		invalidate() {},
	};
	const previous = mock(() => editor);
	const ui = editorUI(previous);
	const opened = mock(() => {});
	let enabled = true;
	const dispose = bindDoubleLeftNavigation(ui, () => enabled, opened);
	const wrapped = ui.getEditorComponent()?.(
		{} as TUI,
		editorTheme,
		keybindings,
	);
	expect(wrapped).toBe(editor);
	forwarded.mockClear();
	wrapped?.handleInput(left);
	expect(forwarded).toHaveBeenCalledWith(left);
	expect(opened).not.toHaveBeenCalled();
	wrapped?.handleInput(left);
	expect(forwarded).toHaveBeenCalledTimes(1);
	expect(opened).toHaveBeenCalledTimes(1);
	expect(wrapped?.getText()).toBe("");
	enabled = false;
	wrapped?.handleInput(left);
	wrapped?.handleInput(left);
	expect(opened).toHaveBeenCalledTimes(1);
	dispose();
	dispose();
	expect(ui.getEditorComponent()).toBe(previous);
	expect(editor.handleInput).toBe(forwarded);
	expect(ui.setEditorComponent).toHaveBeenCalledTimes(2);
});

test.each(["draft", "first\nsecond"])(
	"main navigation only opens at the text start when the editor contains %j",
	(text) => {
		const tui = { requestRender() {}, terminal: { rows: 24 } } as TUI;
		const editor = new CustomEditor(tui, editorTheme, keybindings);
		const handleInput = editor.handleInput;
		const forwarded = mock((data: string) => handleInput.call(editor, data));
		editor.handleInput = forwarded;
		const ui = editorUI(() => editor);
		const opened = mock(() => {});
		const dispose = bindDoubleLeftNavigation(ui, () => true, opened);
		ui.getEditorComponent()?.(tui, editorTheme, keybindings);
		try {
			editor.setText(text);
			let moves = 0;
			while (!atTextStart(editor) && moves < 20) {
				editor.handleInput(left);
				moves++;
				expect(opened).not.toHaveBeenCalled();
			}
			expect(atTextStart(editor)).toBe(true);
			expect(forwarded).toHaveBeenCalledTimes(moves);
			// A Left that moved the cursor must not arm a navigation chord.
			editor.handleInput(left);
			expect(opened).not.toHaveBeenCalled();
			editor.handleInput(left);
			expect(opened).toHaveBeenCalledTimes(1);
			expect(forwarded).toHaveBeenCalledTimes(moves + 1);
			expect(editor.getText()).toBe(text);
			editor.handleInput("X");
			expect(editor.getText()).toBe(`X${text}`);
		} finally {
			dispose();
		}
	},
);

test("leaving the text start clears a pending chord before returning to empty", () => {
	const tui = { requestRender() {}, terminal: { rows: 24 } } as TUI;
	const editor = new CustomEditor(tui, editorTheme, keybindings);
	const ui = editorUI(() => editor);
	const opened = mock(() => {});
	const dispose = bindDoubleLeftNavigation(ui, () => true, opened);
	ui.getEditorComponent()?.(tui, editorTheme, keybindings);
	try {
		editor.handleInput(left);
		editor.setText("draft");
		editor.handleInput(left);
		expect(opened).not.toHaveBeenCalled();
		editor.setText("");
		editor.handleInput(left);
		expect(opened).not.toHaveBeenCalled();
		editor.handleInput(left);
		expect(opened).toHaveBeenCalledTimes(1);
	} finally {
		dispose();
	}
});

test("split bracketed paste cannot trigger main navigation", () => {
	const tui = { requestRender() {}, terminal: { rows: 24 } } as TUI;
	const editor = new CustomEditor(tui, editorTheme, keybindings);
	const ui = editorUI(() => editor);
	const opened = mock(() => {});
	const dispose = bindDoubleLeftNavigation(ui, () => true, opened);
	ui.getEditorComponent()?.(tui, editorTheme, keybindings);
	try {
		editor.handleInput("\x1b[200~");
		editor.handleInput(left);
		editor.handleInput(left);
		editor.handleInput("\x1b[201~");
		expect(opened).not.toHaveBeenCalled();
		editor.setText("");
		editor.handleInput(left);
		expect(opened).not.toHaveBeenCalled();
		editor.handleInput(left);
		expect(opened).toHaveBeenCalledTimes(1);
	} finally {
		dispose();
	}
});

test("a later line's beginning is not the beginning of the text", () => {
	const tui = { requestRender() {}, terminal: { rows: 24 } } as TUI;
	const editor = new CustomEditor(tui, editorTheme, keybindings);
	editor.setText("first\nsecond");
	editor.handleInput("\x01"); // Ctrl+A moves to the current line's beginning.
	expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
	expect(atTextStart(editor)).toBe(false);
	editor.handleInput("\x1b[A");
	expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	expect(atTextStart(editor)).toBe(true);
});

test("custom editors without cursor access only navigate when empty", () => {
	expect(atTextStart({ getText: () => "draft" })).toBe(false);
	expect(atTextStart({ getText: () => "" })).toBe(true);
});

test("cleanup does not replace an editor subsequently installed by another extension", () => {
	const ui = editorUI();
	const dispose = bindDoubleLeftNavigation(
		ui,
		() => true,
		() => {},
	);
	const replacement: NonNullable<EditorFactory> = () => {
		throw new Error("not instantiated");
	};
	ui.setEditorComponent(replacement);
	dispose();
	expect(ui.getEditorComponent()).toBe(replacement);
});

test("the real fullscreen input dispatcher does not open subagents from another dialog", () => {
	let input = (_data: string) => {};
	const terminal: Terminal = {
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start(onInput) {
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
	const liveEditor = new CustomEditor(tui, editorTheme, keybindings, {
		embedWorkingStatus: true,
	});
	const handleInput = liveEditor.handleInput;
	tui.addChild(liveEditor);
	tui.setFocus(liveEditor);
	const ui = editorUI();
	const opened = mock(() => {});
	const dispose = bindDoubleLeftNavigation(ui, () => true, opened);
	const editor = ui.getEditorComponent()?.(tui, editorTheme, keybindings);
	if (!editor) throw new Error("Missing editor");
	expect(editor).toBe(liveEditor);
	expect(liveEditor.embedWorkingStatus).toBe(true);
	try {
		tui.start();
		tui.renderNow(true);
		const dialog = new Input();
		const overlay = tui.showOverlay(dialog, { width: 30 });
		input(left);
		input(left);
		expect(opened).not.toHaveBeenCalled();
		expect(overlay.isFocused()).toBe(true);
		overlay.hide();
		input("main draft");
		input(left);
		expect(opened).not.toHaveBeenCalled();
		input(left);
		expect(opened).not.toHaveBeenCalled();
		input("X");
		expect(editor.getText()).toBe("main draXft");
		editor.setText("");
		input(left);
		expect(opened).not.toHaveBeenCalled();
		input(left);
		expect(opened).toHaveBeenCalledTimes(1);
	} finally {
		dispose();
		expect(liveEditor.handleInput).toBe(handleInput);
		tui.stop();
	}
});
