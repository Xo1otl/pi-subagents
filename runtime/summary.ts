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

const TOKEN_KEYS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"totalTokens",
] as const;
const OPTIONAL_TOKEN_KEYS = ["reasoning", "cacheWrite1h"] as const;
const COST_KEYS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"total",
] as const;

/** The charge an entry records: a model response, a tool's own, or a usage entry. */
function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message")
		return "usage" in entry ? entry.usage : undefined;
	const { message } = entry;
	return message.role === "assistant" || message.role === "toolResult"
		? message.usage
		: undefined;
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
		const used = entryUsage(entry);
		if (!used) continue;
		for (const key of TOKEN_KEYS) usage[key] += used[key];
		for (const key of OPTIONAL_TOKEN_KEYS)
			if (used[key] !== undefined) usage[key] = (usage[key] ?? 0) + used[key];
		for (const key of COST_KEYS) usage.cost[key] += used.cost[key];
	}
	return usage;
}

/** Propagate only new, local charges; descendants bill every ancestor themselves. */
export function summarizeOwnUsage(entries: readonly SessionEntry[]): Usage {
	return summarizeUsage(entries, true);
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
