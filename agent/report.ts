import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionOwner } from "../runtime/index.ts";
import { REPORT_TOOL, type ReportDetails } from "./protocol.ts";

/** How a subagent delivers its result. The report is kept as the tool
 * result's state, not picked from the chat; the latest one reaches the parent
 * once the agent is idle with nothing left to wait for. What it left running
 * is stopped at once: the agent alone is told, and decides whether that
 * changes its result.
 */
export function reportTool({ runtime, id }: SessionOwner) {
	return defineTool({
		name: REPORT_TOOL,
		label: "Report",
		description:
			"Deliver your result to your parent agent and end your run. Report once all work (incl. child agents and tracked bg jobs) is done. (Any leftovers will be force-stopped.)",
		// The one line a subagent's system prompt gains, as the tool exists only
		// there. With the declaration alone, models answered their task in the
		// chat and reported only once reminded; terser wording did not hold.
		promptGuidelines: [
			"You are a subagent: your 1st message is your parent agent's task. End it with report, the only thing the parent sees.",
		],
		parameters: Type.Object({ result: Type.String({ minLength: 1 }) }),
		// Only the model's own calls can end its turn.
		exposure: "model-only",
		async execute(_toolCallId, { result }) {
			const details: ReportDetails = { result };
			// A conversation the user continued is theirs: the parent already
			// has the task's result.
			if (runtime.get(id)?.delegated !== true)
				return {
					content: [
						{
							type: "text",
							text: "Not delivered: your parent already has your result.",
						},
					],
					details,
					isError: true,
					terminate: true,
				};
			const stopped = runtime.stopLeftovers(id);
			return {
				content: [
					{
						type: "text",
						text: stopped.length
							? `Reported; leftovers stopped: ${stopped.join("; ")}. Report again if that changes your result.`
							: "Reported.",
					},
				],
				details,
				// Nothing left: skip the follow-up request. Otherwise the agent
				// judges what it cut short.
				terminate: stopped.length === 0,
			};
		},
	});
}
