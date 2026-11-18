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

type TextCursor = Pick<EditorComponent, "getText"> &
	Partial<Pick<Editor, "getCursor">>;

function atTextStart(editor: TextCursor): boolean {
	const cursor = editor.getCursor?.();
	return cursor
		? cursor.line === 0 && cursor.col === 0
		: editor.getText() === "";
}

export function createPasteGuard(): (data: string) => boolean {
	let pasting = false;
	return (data) => {
		const pasted = pasting || data.includes("\x1b[200~");
		if (pasted) pasting = !data.includes("\x1b[201~");
		return pasted;
	};
}

export function createDoubleLeft() {
	let previous: number | undefined;
	return {
		matches(data: string, editor: TextCursor, now = performance.now()) {
			if (isKeyRelease(data)) return false;
			const last = previous;
			previous = undefined;
			if (isKeyRepeat(data) || !matchesKey(data, "left")) return false;
			if (!atTextStart(editor)) return false;
			if (last !== undefined && now - last <= 500) return true;
			previous = now;
			return false;
		},
		reset(): void {
			previous = undefined;
		},
	};
}

type EditorFactory = NonNullable<
	ReturnType<ExtensionUIContext["getEditorComponent"]>
>;

function focusedEditor(tui: TUI): EditorComponent | undefined {
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

export function bindDoubleLeftNavigation(
	ui: Pick<ExtensionUIContext, "getEditorComponent" | "setEditorComponent">,
	enabled: () => boolean,
	onOpen: () => void,
): () => void {
	const previousFactory = ui.getEditorComponent();
	const restores: (() => void)[] = [];
	let disposed = false;
	const factory: EditorFactory = (tui, theme, keybindings) => {
		const editor =
			focusedEditor(tui) ??
			previousFactory?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
		const handleInput = editor.handleInput;
		const isPaste = createPasteGuard();
		const doubleLeft = createDoubleLeft();
		const wrapped = (data: string) => {
			if (isPaste(data) || disposed || !enabled()) doubleLeft.reset();
			else if (doubleLeft.matches(data, editor)) {
				onOpen();
				return;
			}
			handleInput.call(editor, data);
		};
		editor.handleInput = wrapped;
		restores.push(() => {
			if (editor.handleInput === wrapped) editor.handleInput = handleInput;
		});
		return editor;
	};
	ui.setEditorComponent(factory);
	return () => {
		if (disposed) return;
		disposed = true;
		for (const restore of restores.reverse()) restore();
		restores.length = 0;
		if (ui.getEditorComponent() === factory)
			ui.setEditorComponent(previousFactory);
	};
}
