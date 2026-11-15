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
 *
 * The output is the agent's last message, after any earlier ones that still
 * stand. A message that ended a turn stands when only notices (custom messages
 * of `noticeTypes`) started the next: a notice gives the agent no work, so its
 * reply may be a mere acknowledgement, which must not replace a report. Any
 * other input supersedes what was said before it.
 */
export function summarizeRun(
	entries: readonly SessionEntry[],
	cancelled: boolean,
	error: string | undefined,
	noticeTypes: ReadonlySet<string> = new Set(),
): RunSummary {
	let final: AssistantMessage | undefined;
	let standing: string[] = [];
	/** Whether only notices have reached the agent since `final`, if anything. */
	let noticesOnly: boolean | undefined;
	for (const entry of entries) {
		if (entry.type === "custom_message")
			noticesOnly = noticesOnly !== false && noticeTypes.has(entry.customType);
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role === "user") noticesOnly = false;
		if (message.role !== "assistant") continue;
		// Within a turn, messages lead up to its last one, which alone counts.
		if (final?.stopReason === "stop") {
			if (noticesOnly) standing.push(contentText(final.content));
			else standing = [];
		}
		final = message;
		noticesOnly = undefined;
	}
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
		error ||
		[...standing, final ? contentText(final.content) : ""]
			.filter(Boolean)
			.join("\n\n") ||
		"(no output)";
	return { status, error, output, usage };
}
