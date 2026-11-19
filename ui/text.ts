import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Subagent } from "../runtime/index.ts";

export type UITheme = Pick<Theme, "fg">;

export function plain(text: string): string {
	return stripTerminalSequences(text)
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Remove untrusted terminal control characters.
			/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
			"",
		)
		.replaceAll("\t", "    ");
}

export function singleLine(text: string): string {
	return plain(text).replace(/\s+/g, " ");
}

type Activity = Pick<Subagent, "status" | "cancelled" | "interrupted">;

export function statusLabel(node: Activity): string {
	if (node.status !== "running") return node.status;
	if (node.cancelled) return "stopping";
	return node.interrupted ? "interrupted" : "running";
}

export function interruptible(node: Activity | undefined): boolean {
	return node !== undefined && statusLabel(node) === "running";
}

export function stopHint(node: Activity | undefined): string {
	return `Ctrl+C ${interruptible(node) ? "interrupt" : "stop"}`;
}

export function fitHints(hints: readonly string[], width: number): string {
	const parts: string[] = [];
	for (const hint of hints)
		if (visibleWidth([...parts, hint].join(" · ")) <= width) parts.push(hint);
	return parts.join(" · ");
}
