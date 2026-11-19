import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface SubagentToolExecution {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: AgentToolResult<unknown>;
	status: "running" | "done" | "error";
	parentToolCallId?: string;
}

export function updateLiveTools(
	tools: Map<string, SubagentToolExecution>,
	event: AgentSessionEvent,
): void {
	let update: Pick<SubagentToolExecution, "args" | "result" | "status">;
	switch (event.type) {
		case "tool_execution_start":
			update = { args: event.args, status: "running" };
			break;
		case "tool_execution_update":
			update = {
				args: event.args,
				result: event.partialResult,
				status: "running",
			};
			break;
		case "tool_execution_end":
			update = {
				args: tools.get(event.toolCallId)?.args,
				result: event.result,
				status: event.isError ? "error" : "done",
			};
			break;
		default:
			return;
	}
	const { toolCallId, toolName, parentToolCallId } = event;
	tools.set(toolCallId, {
		toolCallId,
		toolName,
		parentToolCallId:
			parentToolCallId ?? tools.get(toolCallId)?.parentToolCallId,
		...update,
	});
}
