import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { UITheme } from "./text.ts";

/** Pi's editor owns multiline editing, paste expansion, history and undo. */
export class ChatEditor extends Editor {
	constructor(tui: TUI, theme: UITheme) {
		super(tui, {
			borderColor: (text) => theme.fg("dim", text),
			selectList: getSelectListTheme(),
		});
	}

	override render(width: number): string[] {
		// Pi 1.2's word wrapper still overflows the stack below three columns.
		if (width >= 3) return super.render(width);
		return super.render(3).map((line) => truncateToWidth(line, width, ""));
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
