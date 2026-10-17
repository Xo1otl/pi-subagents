import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Subagent, Subagents } from "../runtime/index.ts";
import { readContextUsage, renderContextUsage } from "./context-usage.ts";
import { fitHints, singleLine, statusLabel, type UITheme } from "./text.ts";

const HINTS = [
	"Enter open",
	"Esc close",
	"↑↓ select",
	"← parent",
	"→ child",
	"Ctrl+C stop",
	"Tab next",
];

export interface PickerProps {
	runtime: Subagents;
	theme: UITheme;
	keybindings: Pick<KeybindingsManager, "matches">;
	selected: () => string | undefined;
	onSelect: (id: string) => void;
	onOpen: (id: string) => void;
}

export interface Picker {
	render(width: number, height: number): string[];
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

/** The subagent tree with each child's status, task and own context usage,
 * sized to its content rather than the screen.
 */
export function createPicker({
	runtime,
	theme,
	keybindings,
	selected,
	onSelect,
	onOpen,
}: PickerProps): Picker {
	// Clicks target the last displayed frame, not newly arriving agents.
	let rowIds = new Map<number, string>();

	function row(node: Subagent, active: boolean, width: number): string {
		const label = `${active ? ">" : " "} ${"  ".repeat(node.depth - 1)}${node.id} [${statusLabel(node)}] ${singleLine(node.instructions)}`;
		const usage = renderContextUsage(
			readContextUsage(node.session),
			theme,
			true,
		);
		// Reserve the usage column so long IDs or tasks cannot push it out.
		return `${truncateToWidth(
			theme.fg(active ? "accent" : "muted", label),
			Math.max(0, width - visibleWidth(usage) - 1),
			"",
			true,
		)} ${usage}`;
	}

	return {
		render(width, height) {
			const nodes = runtime.tree();
			const id = selected();
			// Compact, so the root conversation stays in view above it.
			const listHeight = Math.max(
				1,
				Math.min(nodes.length, Math.floor(height / 2) - 3),
			);
			const index = Math.max(
				0,
				nodes.findIndex((node) => node.id === id),
			);
			const start = Math.max(
				0,
				Math.min(index - Math.floor(listHeight / 2), nodes.length - listHeight),
			);
			const lines = [
				theme.fg("dim", "─".repeat(width)),
				theme.fg("accent", "Subagents") +
					theme.fg("dim", ` · ${nodes.length} · context`),
			];
			rowIds = new Map();
			for (const node of nodes.slice(start, start + listHeight)) {
				rowIds.set(lines.length, node.id);
				lines.push(row(node, node.id === id, width));
			}
			if (!nodes.length) lines.push(theme.fg("dim", "No subagents yet."));
			lines.push(theme.fg("dim", fitHints(HINTS, width)));
			return lines;
		},
		handleInput(data) {
			const id = selected();
			if (!id) return;
			const nodes = runtime.tree();
			const index = nodes.findIndex((node) => node.id === id);
			const parentId = runtime.get(id)?.parentId;
			const child = nodes.find((node) => node.parentId === id);
			if (matchesKey(data, "up") || keybindings.matches(data, "tui.select.up"))
				onSelect(nodes[Math.max(0, index - 1)]?.id ?? id);
			else if (
				matchesKey(data, "down") ||
				keybindings.matches(data, "tui.select.down")
			)
				onSelect(nodes[Math.min(nodes.length - 1, index + 1)]?.id ?? id);
			else if (matchesKey(data, "left")) {
				// Top-level agents have no selectable parent.
				if (parentId && runtime.get(parentId)) onSelect(parentId);
			} else if (matchesKey(data, "right")) {
				if (child) onSelect(child.id);
				else onOpen(id);
			} else if (keybindings.matches(data, "tui.input.submit")) onOpen(id);
		},
		handleMouse(event) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const id = rowIds.get(event.y);
			if (!id) return undefined;
			onOpen(id);
			return { handled: true };
		},
	};
}
