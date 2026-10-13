import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	sliceByColumn,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export type ChatTUI = Pick<TUI, "requestRender"> & {
	terminal: Pick<TUI["terminal"], "rows">;
};

/** Pi's editor owns multiline editing, paste expansion, history and undo. */
export class ChatEditor extends Editor {
	private cropColumns = new Map<number, number>();

	override render(width: number): string[] {
		// Pi 1.1's word wrapper recurses on a two-column grapheme in a one-column
		// editor. Lay out at a safe width, then expose a cursor-centered slice.
		const lines = super.render(Math.max(3, width));
		this.cropColumns.clear();
		if (width >= 3) return lines;
		return lines.map((line, row) => {
			const cursorIndex = line.indexOf(CURSOR_MARKER);
			if (cursorIndex < 0) return truncateToWidth(line, width, "");
			const column = visibleWidth(line.slice(0, cursorIndex));
			const start = Math.max(0, column - width + 1);
			this.cropColumns.set(row, start);
			const before = sliceByColumn(
				line.slice(0, cursorIndex),
				start,
				column - start,
				true,
			);
			const after = sliceByColumn(
				line.slice(cursorIndex + CURSOR_MARKER.length),
				0,
				width - visibleWidth(before),
				true,
			);
			return before + CURSOR_MARKER + after;
		});
	}

	override handleMouse(event: TuiMouseEvent) {
		return super.handleMouse({
			...event,
			x: event.x + (this.cropColumns.get(event.y) ?? 0),
			width: Math.max(3, event.width),
		});
	}

	constructor(tui: ChatTUI, theme: Pick<Theme, "fg">) {
		// Editor uses only terminal.rows and requestRender from the enclosing TUI.
		super(tui as TUI, {
			borderColor: (text) => theme.fg("dim", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		});
	}

	protected override renderTopBorder(
		width: number,
		hiddenLineCount: number,
	): string {
		if (hiddenLineCount || width < 8)
			return super.renderTopBorder(width, hiddenLineCount);
		const label = truncateToWidth(
			" Message this subagent… ",
			Math.max(0, width - 2),
			"",
		);
		return this.borderColor(
			`─${label}${"─".repeat(Math.max(0, width - visibleWidth(label) - 1))}`,
		);
	}
}

/** On tiny screens crop the editor around its cursor, never the cursor itself.
 * Keep the offset so clicks can be translated into the editor's original geometry.
 */
export function fitComposer(lines: readonly string[], height: number) {
	height = Math.max(1, height);
	const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
	const center = cursor >= 0 ? cursor : Math.max(0, lines.length - 2);
	const offset = Math.max(
		0,
		Math.min(center - Math.floor(height / 2), lines.length - height),
	);
	return { lines: lines.slice(offset, offset + height), offset };
}
