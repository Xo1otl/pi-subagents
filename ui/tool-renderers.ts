import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isSubagentReceipt, subagentId } from "../agent/protocol.ts";
import { plain, singleLine, type UITheme } from "./text.ts";

/** Collapsed results show this many lines, each cut to PREVIEW_COLUMNS. */
const PREVIEW_LINES = 8;
const PREVIEW_COLUMNS = 240;
const CALL_PREVIEW_COLUMNS = 160;

export function renderSubagentCall(args: unknown, theme: UITheme): Text {
	const instructions =
		args && typeof args === "object" && "instructions" in args
			? args.instructions
			: undefined;
	return new Text(
		theme.fg("toolTitle", "Subagent ") +
			singleLine(String(instructions ?? "…")).slice(0, CALL_PREVIEW_COLUMNS),
		0,
		0,
	);
}

export function renderSubagentResult(
	result: AgentToolResult<unknown>,
	{
		isPartial,
		expanded,
	}: Pick<ToolRenderResultOptions, "isPartial" | "expanded">,
	theme: UITheme,
): Text {
	if (isPartial) return new Text(theme.fg("muted", "Delegating…"), 0, 0);
	const text = plain(contentText(result.content));
	if (isSubagentReceipt(result.details)) {
		const { id } = result.details;
		return new Text(
			theme.fg("muted", `Subagent ${id} · running in background`) +
				theme.fg("dim", `\n/subagents ${id} · view conversation`),
			0,
			0,
		);
	}
	const id = subagentId(result.details);
	const lines = text.split("\n");
	const preview = expanded
		? text
		: lines
				.slice(0, PREVIEW_LINES)
				.map((line) => line.slice(0, PREVIEW_COLUMNS))
				.join("\n");
	const hint = id ? `\n/subagents ${id} · view conversation` : "";
	const hidden = expanded ? 0 : lines.length - PREVIEW_LINES;
	const more =
		hidden > 0
			? theme.fg("dim", `\n… ${hidden} more lines · Ctrl+O to expand`)
			: "";
	return new Text(preview + more + theme.fg("dim", hint), 0, 0);
}
