import {
	type Api,
	type AssistantMessage,
	contentText,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type {
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

/** Attribution for asynchronous delegation, outside a tool result's usage. */
export const SUBAGENT_USAGE_KIND = "pi-subagents";

export interface RunSummary {
	status: "done" | "error" | "aborted";
	error?: string;
	output: string;
	usage: Usage;
}

/** Bill one run's own usage to an ancestor, independently of result delivery. */
export function appendDelegatedUsage(
	manager: SessionManager,
	model: Model<Api>,
	child: { id: string; usage: Usage },
): void {
	manager.appendUsage(
		SUBAGENT_USAGE_KIND,
		model.provider,
		model.id,
		child.usage,
		child.id,
	);
}

/** Raw entries are the single source of billing, including descendant charges. */
function summarizeUsage(entries: readonly SessionEntry[]): Usage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const usages = entries.flatMap((entry) => {
		if (entry.type === "message") {
			const message = entry.message;
			return (message.role === "assistant" || message.role === "toolResult") &&
				message.usage
				? [message.usage]
				: [];
		}
		return "usage" in entry && entry.usage ? [entry.usage] : [];
	});
	for (const used of usages) {
		usage.input += used.input;
		usage.output += used.output;
		usage.cacheRead += used.cacheRead;
		usage.cacheWrite += used.cacheWrite;
		usage.totalTokens += used.totalTokens;
		if (used.reasoning !== undefined)
			usage.reasoning = (usage.reasoning ?? 0) + used.reasoning;
		if (used.cacheWrite1h !== undefined)
			usage.cacheWrite1h = (usage.cacheWrite1h ?? 0) + used.cacheWrite1h;
		for (const key of [
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"total",
		] as const) {
			usage.cost[key] += used.cost[key];
		}
	}
	return usage;
}

/** Propagate only new, local charges; descendants bill every ancestor themselves. */
export function summarizeOwnUsage(entries: readonly SessionEntry[]): Usage {
	return summarizeUsage(
		entries.filter(
			(entry) => entry.type !== "usage" || entry.kind !== SUBAGENT_USAGE_KIND,
		),
	);
}

/** Derive one run's result from the raw entries it appended.
 * Raw entries survive compaction and context edits, so neither final output
 * nor billing disappears when a full pi session repairs its model context.
 */
export function summarizeRun(
	entries: readonly SessionEntry[],
	cancelled: boolean,
	error: string | undefined,
): RunSummary {
	let final: AssistantMessage | undefined;
	for (const entry of entries)
		if (entry.type === "message" && entry.message.role === "assistant")
			final = entry.message;
	const usage = summarizeUsage(entries);
	let status: RunSummary["status"];
	if (cancelled || final?.stopReason === "aborted") {
		status = "aborted";
		error = "Subagent was aborted.";
	} else if (error || (final && final.stopReason !== "stop")) {
		status = "error";
		error ??=
			final?.errorMessage ??
			`Subagent ended without a complete response (${final?.stopReason ?? "no response"}).`;
	} else {
		status = "done";
	}
	const output =
		error || (final && contentText(final.content)) || "(no output)";
	return { status, error, output, usage };
}
