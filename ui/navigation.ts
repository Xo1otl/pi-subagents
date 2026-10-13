import {
	CustomEditor,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	type Editor,
	type EditorComponent,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	type TUI,
	type TuiAltScreen,
} from "@earendil-works/pi-tui";

/** A short Left-Left chord; the first key can still move the cursor. */
export function createDoubleLeftDetector() {
	let previous: number | undefined;
	return {
		matches(data: string, now = performance.now()): boolean {
			// Kitty releases occur between taps; holding a key is not a second tap.
			if (isKeyRelease(data)) return false;
			const last = previous;
			previous = undefined;
			if (isKeyRepeat(data) || !matchesKey(data, "left")) return false;
			if (last !== undefined && now - last <= 500) return true;
			previous = now;
			return false;
		},
		reset(): void {
			previous = undefined;
		},
	};
}

function focusedEditor(tui: TUI): EditorComponent | undefined {
	// Both pi renderers expose this public method, though the common TUI interface
	// omits it. Reuse the live editor to retain undo and prompt history.
	const renderer = tui as TUI &
		Partial<Pick<TuiAltScreen, "getFocusedComponent">>;
	const editor = renderer.getFocusedComponent?.();
	if (
		editor &&
		"getText" in editor &&
		typeof editor.getText === "function" &&
		"setText" in editor &&
		typeof editor.setText === "function" &&
		typeof editor.handleInput === "function"
	)
		return editor as EditorComponent;
	return undefined;
}

export function atTextStart(
	editor: Pick<EditorComponent, "getText"> & Partial<Pick<Editor, "getCursor">>,
): boolean {
	const cursor = editor.getCursor?.();
	return cursor
		? cursor.line === 0 && cursor.col === 0
		: editor.getText() === "";
}

/** Scope the chord to the text start, preserving any existing custom editor. */
export function bindDoubleLeftNavigation(
	ui: Pick<ExtensionUIContext, "getEditorComponent" | "setEditorComponent">,
	enabled: () => boolean,
	onOpen: () => void,
): () => void {
	const previousFactory = ui.getEditorComponent();
	const doubleLeft = createDoubleLeftDetector();
	let disposed = false;
	const restoreInputs: (() => void)[] = [];
	const factory: NonNullable<
		ReturnType<ExtensionUIContext["getEditorComponent"]>
	> = (tui, theme, keybindings) => {
		doubleLeft.reset();
		const editor =
			focusedEditor(tui) ??
			previousFactory?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
		const handleInput = editor.handleInput;
		let pasting = false;
		const wrappedInput = (data: string) => {
			const pasteStart = data.includes("\x1b[200~");
			if (
				disposed ||
				!enabled() ||
				pasting ||
				pasteStart ||
				!atTextStart(editor)
			)
				doubleLeft.reset();
			else if (doubleLeft.matches(data)) {
				onOpen();
				return;
			}
			if (pasting || pasteStart) pasting = !data.includes("\x1b[201~");
			handleInput.call(editor, data);
		};
		editor.handleInput = wrappedInput;
		restoreInputs.push(() => {
			if (editor.handleInput === wrappedInput) editor.handleInput = handleInput;
		});
		return editor;
	};
	ui.setEditorComponent(factory);
	return () => {
		if (disposed) return;
		disposed = true;
		doubleLeft.reset();
		for (const restore of restoreInputs.reverse()) restore();
		restoreInputs.length = 0;
		// Another extension may have installed its own editor after ours.
		if (ui.getEditorComponent() === factory)
			ui.setEditorComponent(previousFactory);
	};
}
