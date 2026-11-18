import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubagentResult } from "../runtime/index.ts";

export const SUBAGENT_RESULT_TYPE = "subagent-result";
export const SUBAGENT_USAGE_TYPE = "subagent-usage";
export const SUBAGENT_REMINDER_TYPE = "subagent-reminder";
export const COMMAND_EXIT_TYPE = "bg-exit";
export const COMMAND_UNKNOWN_TYPE = "bg-unknown";
export const REPORT_TOOL = "report_to_parent";
export const SUBAGENT_ROLE_SECTION = "subagent_role";

export interface ReportDetails {
	result: string;
}

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
	customType: typeof SUBAGENT_RESULT_TYPE;
	content: AgentToolResult<unknown>["content"];
	display: boolean;
	details: SubagentCompletionDetails;
}

export interface CommandJob {
	pgid: number;
	command: string;
	cwd: string;
}

interface CommandExitDetails extends CommandJob {
	exitCode: null;
}

export interface CommandExitMessage {
	customType: typeof COMMAND_EXIT_TYPE;
	content: string;
	display: boolean;
	details: CommandExitDetails;
}

interface CommandUnknownDetails extends CommandJob {
	error: string;
}

export interface CommandUnknownMessage {
	customType: typeof COMMAND_UNKNOWN_TYPE;
	content: string;
	display: boolean;
	details: CommandUnknownDetails;
}

export type CommandMessage = CommandExitMessage | CommandUnknownMessage;

function stringField(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const field: unknown = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

export function subagentId(details: unknown): string | undefined {
	return stringField(details, "id");
}

export function subagentInstructions(args: unknown): string | undefined {
	return stringField(args, "instructions");
}

export function isSubagentReceipt(
	details: unknown,
): details is SubagentReceipt {
	return (
		subagentId(details) !== undefined &&
		stringField(details, "status") === "running"
	);
}

export function subagentReceipt(id: string): AgentToolResult<SubagentReceipt> {
	const receipt: SubagentReceipt = { id, status: "running" };
	return {
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		structuredContent: { ...receipt },
	};
}

export function reportResult(args: unknown): string | undefined {
	return stringField(args, "result");
}

export function reportOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const { message } = entry;
	return message.role === "toolResult" &&
		message.toolName === REPORT_TOOL &&
		!message.isError
		? reportResult(message.details)
		: undefined;
}
