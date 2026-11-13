import {
	type AssistantMessage,
	contentText,
	type Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Attribution for asynchronous delegation, outside a tool result's usage. */
export const SUBAGENT_USAGE_KIND = "pi-subagents";

export interface RunSummary {
	status: "done" | "error" | "aborted";
	error?: string;
	output: string;
	usage: Usage;
}

/** Raw entries are the single source of billing, including descendant charges. */
function summarizeUsage(
	entries: readonly SessionEntry[],
	ownOnly = false,
): Usage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const entry of entries) {
		if (ownOnly && entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND)
			continue;
		const used =
			entry.type === "message"
				? (entry.message.role === "assistant" ||
						entry.message.role === "toolResult") &&
					entry.message.usage
				: "usage" in entry && entry.usage;
		if (!used) continue;
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
	return summarizeUsage(entries, true);
}

/** The user's message that a run last answered, unless the run began with it
 * or has moved on since: its task comes first, and every wake-up (a result, a
 * command exit, a resumption) is a custom message.
 */
export function lastInterruption(
	entries: readonly SessionEntry[],
): SessionEntry | undefined {
	const inputs = entries.filter(
		(entry) =>
			entry.type === "custom_message" ||
			(entry.type === "message" && entry.message.role === "user"),
	);
	const last = inputs.at(-1);
	return inputs.length > 1 && last?.type === "message" ? last : undefined;
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
