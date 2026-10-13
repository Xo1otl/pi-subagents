import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentResult } from "../runtime/index.ts";

/** What the integration emits and persists, shared with presentation.
 * Pure data and parsing only; producing completions lives in completions.ts.
 */
export const SUBAGENT_RESULT_TYPE = "subagent-result";
export const SUBAGENT_USAGE_TYPE = "subagent-usage";

export interface SubagentReceipt {
	id: string;
	status: "running";
}

export interface SubagentCompletionDetails {
	id: string;
	status: SubagentResult["status"];
	error?: string;
	usage: Usage;
	fullOutputPath?: string;
}

export interface SubagentCompletionMessage {
	customType: string;
	content: AgentToolResult<unknown>["content"];
	display: boolean;
	details: SubagentCompletionDetails;
}

/** Details may come from persisted sessions, so they are checked rather than trusted. */
export function subagentId(details: unknown): string | undefined {
	return details &&
		typeof details === "object" &&
		"id" in details &&
		typeof details.id === "string"
		? details.id
		: undefined;
}

export function isSubagentReceipt(
	details: unknown,
): details is SubagentReceipt {
	return (
		subagentId(details) !== undefined &&
		(details as Partial<SubagentReceipt>).status === "running"
	);
}

export function subagentReceipt({
	id,
}: {
	id: string;
}): AgentToolResult<SubagentReceipt> {
	const receipt: SubagentReceipt = { id, status: "running" };
	return {
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		structuredContent: { ...receipt },
	};
}
