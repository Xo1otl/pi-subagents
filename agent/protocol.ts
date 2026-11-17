import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubagentResult } from "../runtime/index.ts";

/** What the integration emits and persists, shared with presentation.
 * Pure data and parsing only; producing completions lives in completions.ts.
 */
export const SUBAGENT_RESULT_TYPE = "subagent-result";
export const SUBAGENT_USAGE_TYPE = "subagent-usage";
export const SUBAGENT_REMINDER_TYPE = "subagent-reminder";
export const COMMAND_EXIT_TYPE = "bg-exit";
export const COMMAND_UNKNOWN_TYPE = "bg-unknown";
/** The tool through which a subagent delivers its result and ends its task. */
export const REPORT_TOOL = "report_to_parent";
/** The system prompt section that gives a delegated session its role, only
 * while its parent's task runs.
 */
export const SUBAGENT_ROLE_SECTION = "subagent_role";

/** A report is kept as the tool result's state, never shown to the model. */
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

/** A process group that outlived the command that started it. */
export interface CommandJob {
	pgid: number;
	command: string;
	cwd: string;
}

interface CommandExitDetails extends CommandJob {
	/** A job that outlived its shell has no known status, not an implied success. */
	exitCode: null;
}

export interface CommandExitMessage {
	customType: typeof COMMAND_EXIT_TYPE;
	content: string;
	display: boolean;
	details: CommandExitDetails;
}

interface CommandUnknownDetails extends CommandJob {
	/** Why the group's status could not be read. */
	error: string;
}

/** A group whose status stayed unknown: neither stopped nor forgotten. */
export interface CommandUnknownMessage {
	customType: typeof COMMAND_UNKNOWN_TYPE;
	content: string;
	display: boolean;
	details: CommandUnknownDetails;
}

/** What command tracking tells the conversation that ran the command. */
export type CommandMessage = CommandExitMessage | CommandUnknownMessage;

/** A string property of an untrusted value, e.g. persisted details or
 * partial tool arguments, which are checked rather than trusted.
 */
function stringField(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const field: unknown = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

export function subagentId(details: unknown): string | undefined {
	return stringField(details, "id");
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

/** The result a report tool call carries, if its arguments are complete. */
export function reportResult(args: unknown): string | undefined {
	return stringField(args, "result");
}

/** The report an entry records, if any: a successful report's stored result. */
export function reportOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const { message } = entry;
	return message.role === "toolResult" &&
		message.toolName === REPORT_TOOL &&
		!message.isError
		? reportResult(message.details)
		: undefined;
}
