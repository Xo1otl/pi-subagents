import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Leftover, SessionOwner } from "../runtime/index.ts";
import {
	REPORT_TOOL,
	type ReportDetails,
	SUBAGENT_ROLE_SECTION,
} from "./protocol.ts";

const ROLE = `You are a subagent. Chat is hidden from the parent; ending your turn just leaves you idle, while \`${REPORT_TOOL}\` reaches the parent. Mid-run interjections come from the user, not the parent.`;

export function registerReporting(pi: ExtensionAPI, owner: SessionOwner): void {
	pi.registerTool(reportTool(owner));
	pi.on("before_agent_start", ({ systemPromptOptions }) => {
		if (owner.runtime.get(owner.id)?.delegated)
			systemPromptOptions.sections[SUBAGENT_ROLE_SECTION] = ROLE;
	});
}

const reply = (text: string) => [{ type: "text" as const, text }];

const labels = (work: readonly Leftover[]) =>
	work.map(({ label }) => label).join("; ");

function reportTool({ runtime, id }: SessionOwner) {
	const told = new WeakSet<Leftover>();
	return defineTool({
		name: REPORT_TOOL,
		label: "Report",
		description: "Declares the task complete and submits the final report.",
		parameters: Type.Object({ result: Type.String({ minLength: 1 }) }),
		exposure: "model-only",
		async execute(_toolCallId, { result }) {
			const details: ReportDetails = { result };
			if (!runtime.get(id)?.delegated)
				return {
					content: reply("Not delivered: your parent already has your report."),
					details,
					isError: true,
					terminate: true,
				};
			const { children, work } = runtime.leftovers(id);
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
				terminate: true,
			};
		},
	});
}
