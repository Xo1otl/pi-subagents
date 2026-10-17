import { expect, mock, test } from "bun:test";
import {
	CustomEditor,
	type ExtensionUIContext,
	getSelectListTheme,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	bindDoubleLeftNavigation,
	createDoubleLeft,
} from "../ui/navigation.ts";

const left = "\x1b[D";
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

test("the chord is two Left taps within 500 ms at the text start, in any key encoding", () => {
	const chord = createDoubleLeft();
	const empty = { getText: () => "" };
	expect(chord.matches(left, empty, 0)).toBe(false);
	expect(chord.matches(left, empty, 500)).toBe(true);
	expect(chord.matches(left, empty, 501)).toBe(false);
	expect(chord.matches(left, empty, 1100)).toBe(false); // Too slow.
	expect(chord.matches("\x1bOD", empty, 1200)).toBe(true);
	// Kitty releases between taps are ignored; a held key's repeats are not taps.
	expect(chord.matches("\x1b[1;1:3D", empty, 1300)).toBe(false);
	expect(chord.matches(left, empty, 1300)).toBe(false);
	expect(chord.matches("\x1b[1;1:3D", empty, 1350)).toBe(false);
	expect(chord.matches("\x1b[1;1D", empty, 1400)).toBe(true);
	for (const other of ["x", "\x1b[C", "\x1b[1;5D", "\x1b[1;1:2D"]) {
		expect(chord.matches(left, empty, 2000)).toBe(false);
		expect(chord.matches(other, empty, 2100)).toBe(false);
		expect(chord.matches(left, empty, 2200)).toBe(false);
		chord.reset();
	}
	// Without cursor access, only an empty editor is at its text start.
	expect(chord.matches(left, { getText: () => "draft" }, 3000)).toBe(false);
	expect(chord.matches(left, { getText: () => "draft" }, 3100)).toBe(false);
});

test("the root editor opens the switcher only from its text start, never from pasted or disabled Lefts", () => {
	const tui = { requestRender() {}, terminal: { rows: 24 } } as TUI;
	const live = new CustomEditor(tui, editorTheme, keybindings);
	const previous = mock(() => live);
	const ui = editorUI(previous);
	const opened = mock(() => {});
	let enabled = false;
	const dispose = bindDoubleLeftNavigation(ui, () => enabled, opened);
	try {
		expect(ui.getEditorComponent()?.(tui, editorTheme, keybindings)).toBe(live);
		live.handleInput(left);
		live.handleInput(left);
		expect(opened).not.toHaveBeenCalled();
		enabled = true;
		live.setText("first\nsecond");
		live.handleInput("\x01"); // The second line's beginning is not the text start.
		live.handleInput(left);
		live.handleInput(left);
		expect(live.getCursor()).toEqual({ line: 0, col: 4 });
		while (live.getCursor().col > 0) live.handleInput(left);
		live.handleInput(left); // Moves nowhere, but arms the chord.
		for (const chunk of ["\x1b[200~", left, left, "\x1b[201~"])
			live.handleInput(chunk);
		expect(opened).not.toHaveBeenCalled();
		expect(live.getText()).toBe("[D[Dfirst\nsecond");
		while (live.getCursor().col > 0) live.handleInput(left);
		live.handleInput(left);
		expect(opened).not.toHaveBeenCalled();
		live.handleInput(left);
		expect(opened).toHaveBeenCalledTimes(1);
		live.handleInput("X");
		expect(live.getText()).toBe("X[D[Dfirst\nsecond");
	} finally {
		dispose();
	}
});

test("root binding cleanup is idempotent and restores the editor without replacing a later extension's", () => {
	const forwarded = mock((_data: string) => {});
	const editor: EditorComponent = {
		handleInput: forwarded,
		getText: () => "",
		setText() {},
		render: () => [],
		invalidate() {},
	};
	const previous = mock(() => editor);
	const ui = editorUI(previous);
	const dispose = bindDoubleLeftNavigation(
		ui,
		() => true,
		() => {},
	);
	ui.getEditorComponent()?.({} as TUI, editorTheme, keybindings);
	expect(editor.handleInput).not.toBe(forwarded);
	dispose();
	dispose();
	expect(editor.handleInput).toBe(forwarded);
	expect(ui.getEditorComponent()).toBe(previous);
	expect(ui.setEditorComponent).toHaveBeenCalledTimes(2);

	const later = editorUI();
	const disposeLater = bindDoubleLeftNavigation(
		later,
		() => true,
		() => {},
	);
	const replacement: NonNullable<EditorFactory> = () => editor;
	later.setEditorComponent(replacement);
	disposeLater();
	expect(later.getEditorComponent()).toBe(replacement);
});
