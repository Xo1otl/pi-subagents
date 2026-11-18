import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Leftover, SessionOwner } from "../runtime/index.ts";
import {
	REPORT_TOOL,
	type ReportDetails,
	SUBAGENT_ROLE_SECTION,
} from "./protocol.ts";

/** What a delegated session's prompt gains while its parent's task runs. With
 * the tool's declaration alone, models answered their task in the chat and
 * reported only once reminded; terser wording did not hold.
 */
const ROLE = `You are a subagent. Chat is hidden from the parent; ending your turn just leaves you idle, while \`${REPORT_TOOL}\` reaches the parent. Mid-run interjections come from the user, not the parent.`;

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

/** What the reporting agent reads back. */
const reply = (text: string) => [{ type: "text" as const, text }];

const labels = (work: readonly Leftover[]) =>
	work.map(({ label }) => label).join("; ");

/** How a subagent delivers its result. The report is kept as the tool
 * result's state, not picked from the chat; the latest one reaches the parent
 * once the agent is idle with nothing left to wait for.
 *
 * A report stops nothing. Announced in advance, stopping what was left
 * running led agents to detach their jobs from the start, so that nothing
 * woke anyone at their exits. Instead, a report made while jobs run that the
 * agent has not been told of is refused, naming them: only the agent knows
 * whether to wait for their exits, stop them, or leave them running, and
 * leaving them, which the next report does, is the one choice it cannot take
 * back. A report made while children run is refused too, every time: their
 * results are the agent's own, and leaving them running would buy results
 * that nobody receives.
 */
function reportTool({ runtime, id }: SessionOwner) {
	/** Jobs that a refusal named: the next report leaves them running. */
	const told = new WeakSet<Leftover>();
	return defineTool({
		name: REPORT_TOOL,
		label: "Report",
		description: "Declares the task complete and submits the final report.",
		parameters: Type.Object({ result: Type.String({ minLength: 1 }) }),
		// Only the model's own calls can end its turn.
		exposure: "model-only",
		async execute(_toolCallId, { result }) {
			const details: ReportDetails = { result };
			// A conversation the user continued is theirs: the parent already
			// has the task's result.
			if (!runtime.get(id)?.delegated)
				return {
					content: reply("Not delivered: your parent already has your report."),
					details,
					isError: true,
					terminate: true,
				};
			const { children, work } = runtime.leftovers(id);
			// Refusals are no reports: the turn goes on, for the agent to decide.
			if (children.length)
				return {
					content: reply(
						`Not sent: subagents still running: ${children.join(", ")}.`,
					),
					details,
					isError: true,
				};
			if (work.some((job) => !told.has(job))) {
				for (const job of work) told.add(job);
				return {
					content: reply(
						`Not sent: jobs still running: ${labels(work)}. To leave them running untracked, report again.`,
					),
					details,
					isError: true,
				};
			}
			for (const job of work) job.detach();
			return {
				content: reply(
					work.length
						? `Report recorded; left running untracked: ${labels(work)}.`
						: "Report recorded.",
				),
				details,
				// Nothing is left to decide: skip the follow-up request.
				terminate: true,
			};
		},
	});
}
