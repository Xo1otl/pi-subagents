import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type {
	Focusable,
	Keybinding,
	TUI,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Subagent, Subagents } from "../runtime/index.ts";
import { ChatEditor } from "./composer.ts";
import { readContextUsage, renderContextUsage } from "./context-usage.ts";
import { createDoubleLeft } from "./navigation.ts";
import { fitHints, singleLine, statusLabel, type UITheme } from "./text.ts";
import { createTranscriptRenderer, type TranscriptRow } from "./transcript.ts";

export interface ChatProps {
	id: string;
	runtime: Subagents;
	tui: TUI;
	theme: UITheme;
	keybindings: Pick<KeybindingsManager, "matches">;
	onBack: () => void;
}

export interface Chat extends Focusable {
	render(width: number, height: number): string[];
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	/** Pasted text goes to the draft verbatim, never to chat shortcuts. */
	paste(data: string): void;
	/** Return undelivered messages to the draft, ahead of newer text. */
	restore(input: readonly string[]): void;
	invalidate(): void;
	dispose(): void;
}

function hints(width: number): string[] {
	return [
		"Enter send",
		width < 75 ? "Ctrl+J newline" : "Shift+Enter newline",
		"Esc close",
		"←← agents (at text start)",
		"Tab next",
		"Ctrl+O tools",
		"Ctrl+T thinking",
		"Ctrl+C stop",
		"PgUp/PgDn",
		"Ctrl+End live",
	];
}

/** One subagent's conversation and composer. It keeps its draft, undo, history,
 * tool expansion and scroll position while the switcher is open.
 */
export function createChat({
	id,
	runtime,
	tui,
	theme,
	keybindings,
	onBack,
}: ChatProps): Chat {
	const editor = new ChatEditor(tui, theme);
	const transcript = createTranscriptRenderer(theme);
	const doubleLeft = createDoubleLeft();
	const preferences = {
		expandTools: false,
		showThinking: false,
		toolExpanded: new Map<string, boolean>(),
	};
	/** The first visible transcript row, or undefined to follow the end. */
	let pinnedTop: number | undefined;
	let error = "";
	let disposed = false;
	// Scrolling and clicks act on the last displayed frame.
	let frame = {
		visible: [] as readonly TranscriptRow[],
		top: 0,
		maxTop: 0,
		height: 0,
		composerTop: 0,
		composerHeight: 0,
	};

	function scrollTo(top: number): void {
		// Reaching the end resumes following new output.
		pinnedTop = top >= frame.maxTop ? undefined : Math.max(0, top);
	}

	function scrollKey(data: string): number | undefined {
		const page = Math.max(1, frame.height - 1);
		const half = Math.max(1, Math.floor(frame.height / 2));
		const steps: [Keybinding, number][] = [
			["tui.altScreen.pageUp", -page],
			["tui.altScreen.pageDown", page],
			["tui.altScreen.halfPageUp", -half],
			["tui.altScreen.halfPageDown", half],
			["tui.altScreen.lineUp", -1],
			["tui.altScreen.lineDown", 1],
		];
		return steps.find(([key]) => keybindings.matches(data, key))?.[1];
	}

	function header(node: Subagent | undefined, scroll: string): string {
		const nodes = runtime.tree();
		const facts = [
			`${nodes.findIndex((entry) => entry.id === id) + 1}/${nodes.length}`,
			...(node ? [statusLabel(node)] : []),
		];
		const problem = error || node?.error;
		return (
			theme.fg("accent", `Subagent ${id}`) +
			theme.fg("dim", ` · ${facts.join(" · ")} · `) +
			renderContextUsage(readContextUsage(node?.session), theme) +
			theme.fg("dim", ` · ${scroll}`) +
			(problem ? theme.fg("error", ` · ${singleLine(problem)}`) : "")
		);
	}

	editor.onSubmit = (text) => {
		if (disposed || !text.trim()) return;
		editor.addToHistory(text);
		pinnedTop = undefined;
		error = "";
		void runtime.send(id, text).catch((cause: unknown) => {
			if (disposed) return;
			error = cause instanceof Error ? cause.message : String(cause);
			// Preserve failed input, without replacing a newer draft.
			if (!editor.getText()) editor.setText(text);
			tui.requestRender();
		});
	};

	return {
		get focused() {
			return editor.focused;
		},
		set focused(value) {
			editor.focused = value;
			if (!value) doubleLeft.reset();
		},
		render(width, height) {
			const node = runtime.get(id);
			const composer = editor.render(width);
			const bodyHeight = Math.max(0, height - composer.length - 2);
			const rows = node ? transcript.render(node, width, preferences) : [];
			const maxTop = Math.max(0, rows.length - bodyHeight);
			const top = Math.min(pinnedTop ?? maxTop, maxTop);
			const visible = rows.slice(top, top + bodyHeight);
			frame = {
				visible,
				top,
				maxTop,
				height: bodyHeight,
				composerTop: 1 + bodyHeight,
				composerHeight: composer.length,
			};
			return [
				header(node, pinnedTop === undefined ? "live" : `↓${maxTop - top}`),
				...visible.map((row) => row.text),
				...Array<string>(bodyHeight - visible.length).fill(""),
				...composer,
				theme.fg("dim", fitHints(hints(width), width)),
			];
		},
		handleInput(data) {
			const step = scrollKey(data);
			if (doubleLeft.matches(data, editor)) onBack();
			else if (step) scrollTo(frame.top + step);
			else if (keybindings.matches(data, "tui.altScreen.top")) scrollTo(0);
			else if (keybindings.matches(data, "tui.altScreen.bottom"))
				pinnedTop = undefined;
			else if (keybindings.matches(data, "app.tools.expand")) {
				preferences.expandTools = !preferences.expandTools;
				preferences.toolExpanded.clear();
			} else if (keybindings.matches(data, "app.thinking.toggle"))
				preferences.showThinking = !preferences.showThinking;
			else editor.handleInput(data);
		},
		handleMouse(event) {
			if (event.type === "wheel") {
				scrollTo(frame.top + (event.wheelDelta ?? 0));
				return { handled: true };
			}
			// Only clicks: presses and drags remain pi's text selection.
			if (event.type !== "click" || event.button !== "left") return undefined;
			const tool = frame.visible[event.y - 1]?.toolId;
			if (tool) {
				// Keep the clicked header in place instead of following the end.
				pinnedTop = frame.top;
				preferences.toolExpanded.set(
					tool,
					!(preferences.toolExpanded.get(tool) ?? preferences.expandTools),
				);
				return { handled: true };
			}
			const y = event.y - frame.composerTop;
			if (y < 0 || y >= frame.composerHeight) return undefined;
			// Position the cursor without moving keyboard focus off the switcher.
			return editor.handleMouse({ ...event, y })
				? { handled: true }
				: undefined;
		},
		paste(data) {
			doubleLeft.reset();
			editor.handleInput(data);
		},
		restore(input) {
			editor.setText(
				[...input, editor.getText()].filter((text) => text.trim()).join("\n\n"),
			);
		},
		invalidate() {
			transcript.invalidate();
			editor.invalidate();
		},
		dispose() {
			disposed = true;
			editor.focused = false;
		},
	};
}
