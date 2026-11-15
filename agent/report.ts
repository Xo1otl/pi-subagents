import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionOwner } from "../runtime/index.ts";
import {
	REPORT_TOOL,
	type ReportDetails,
	SUBAGENT_ROLE_SECTION,
} from "./protocol.ts";

/** What a delegated session's prompt gains while its parent's task runs. With
 * the tool's declaration alone, models answered their task in the chat and
 * reported only once reminded; terser wording did not hold.
 */
const ROLE = `You are a subagent. Your parent sees what you send via \`${REPORT_TOOL}\`, not this chat. Mid-run interjections come from the user, not the parent.`;

/** Give a delegated session its role and the tool that delivers its result.
 * The role is the session's, not the tool's, and only while it serves its
 * parent's task: a conversation the user takes over drops it. Each run's
 * prompt options start from the session's own, so a run that leaves the
 * section out removes it.
 */
export function registerReporting(pi: ExtensionAPI, owner: SessionOwner): void {
	pi.registerTool(reportTool(owner));
	pi.on("before_agent_start", ({ systemPromptOptions }) => {
		if (owner.runtime.get(owner.id)?.delegated)
			systemPromptOptions.sections[SUBAGENT_ROLE_SECTION] = ROLE;
	});
}

/** How a subagent delivers its result. The report is kept as the tool
 * result's state, not picked from the chat; the latest one reaches the parent
 * once the agent is idle with nothing left to wait for. What it left running
 * is stopped at once: the agent alone is told, and decides whether that
 * changes its result.
 */
function reportTool({ runtime, id }: SessionOwner) {
	return defineTool({
		name: REPORT_TOOL,
		label: "Report",
		description:
			"Submit your final report once all work is done (auto-terminates child agents and tracked BG jobs).",
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
							text: "Not delivered: your parent already has your report.",
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
							? `Report recorded; stopped leftovers: ${stopped.join("; ")}. This report stands unless you report again.`
							: "Report recorded.",
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
