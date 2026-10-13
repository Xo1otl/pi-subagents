import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isSubagentReceipt, subagentId } from "../agent/protocol.ts";
import { plain, singleLine } from "./text.ts";

export function renderSubagentCall(
	args: unknown,
	theme: Pick<Theme, "fg">,
): Text {
	const instructions =
		args && typeof args === "object" && "instructions" in args
			? args.instructions
			: undefined;
	return new Text(
		theme.fg("toolTitle", "Subagent ") +
			singleLine(String(instructions ?? "…")).slice(0, 160),
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
	theme: Pick<Theme, "fg">,
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
				.slice(0, 8)
				.map((line) => line.slice(0, 240))
				.join("\n");
	const hint = id ? `\n/subagents ${id} · view conversation` : "";
	const more =
		!expanded && lines.length > 8
			? theme.fg("dim", `\n… ${lines.length - 8} more lines · Ctrl+O to expand`)
			: "";
	return new Text(preview + more + theme.fg("dim", hint), 0, 0);
}
