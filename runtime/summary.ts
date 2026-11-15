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

const UNREPORTED = "Subagent ended without a report.";

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

export interface RunOutcome {
	cancelled: boolean;
	error?: string;
	/** Present for a delegated task, whose result is its report: the report an
	 * entry records, if any. A conversation the user continued has none; its
	 * output is its last message.
	 */
	reportOf?: (entry: SessionEntry) => string | undefined;
}

/** Derive one run's result from the raw entries it appended.
 * Raw entries survive compaction and context edits, so neither the report
 * nor billing disappears when a full pi session repairs its model context.
 *
 * A delegated task's result is its last report, whatever followed it:
 * neither a later failure nor a stop undoes it. Without one, a task that
 * otherwise ended normally is `unreported`: its output is an error, followed
 * by its last message for diagnosis.
 */
export function summarizeRun(
	entries: readonly SessionEntry[],
	{ cancelled, error, reportOf }: RunOutcome,
): RunSummary & { unreported: boolean } {
	let final: AssistantMessage | undefined;
	let report: string | undefined;
	for (const entry of entries) {
		report = reportOf?.(entry) ?? report;
		if (entry.type === "message" && entry.message.role === "assistant")
			final = entry.message;
	}
	const usage = summarizeUsage(entries);
	if (report !== undefined)
		return {
			status: "done",
			output: report || "(no output)",
			usage,
			unreported: false,
		};
	let status: RunSummary["status"];
	let unreported = false;
	if (cancelled || final?.stopReason === "aborted") {
		status = "aborted";
		error = "Subagent was aborted.";
	} else if (
		error ||
		// A turn may end on tools that terminate it, such as a report.
		(final && final.stopReason !== "stop" && final.stopReason !== "toolUse")
	) {
		status = "error";
		error ??=
			final?.errorMessage ??
			`Subagent ended without a complete response (${final?.stopReason ?? "no response"}).`;
	} else if (reportOf) {
		status = "error";
		error = UNREPORTED;
		unreported = true;
	} else {
		status = "done";
	}
	const last = final ? contentText(final.content) : "";
	const output =
		unreported && last
			? `${UNREPORTED} Its last message:\n\n${last}`
			: error || last || "(no output)";
	return { status, error, output, usage, unreported };
}
