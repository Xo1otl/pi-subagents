import {
	type AssistantMessage,
	contentText,
	type Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message")
		return "usage" in entry ? entry.usage : undefined;
	const { message } = entry;
	return message.role === "assistant" || message.role === "toolResult"
		? message.usage
		: undefined;
}

function summarizeUsage(entries: readonly SessionEntry[]): Usage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const entry of entries) {
		const used = entryUsage(entry);
		if (!used) continue;
		for (const key of TOKEN_KEYS) usage[key] += used[key];
		for (const key of OPTIONAL_TOKEN_KEYS)
			if (used[key] !== undefined) usage[key] = (usage[key] ?? 0) + used[key];
		for (const key of COST_KEYS) usage.cost[key] += used.cost[key];
	}
	return usage;
}

export function summarizeOwnUsage(entries: readonly SessionEntry[]): Usage {
	return summarizeUsage(
		entries.filter(
			(entry) =>
				!(entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND),
		),
	);
}

export interface RunOutcome {
	cancelled: boolean;
	error?: string;
	reportOf?: (entry: SessionEntry) => string | undefined;
}

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
	const done = (output: string) => ({
		status: "done" as const,
		output: output || "(no output)",
		usage,
		unreported: false,
	});
	const failed = (status: "error" | "aborted", reason: string) => ({
		status,
		error: reason,
		output: reason,
		usage,
		unreported: false,
	});

	if (report !== undefined) return done(report);
	if (cancelled || final?.stopReason === "aborted")
		return failed("aborted", "Subagent was aborted.");
	if (
		error ||
		(final && final.stopReason !== "stop" && final.stopReason !== "toolUse")
	)
		return failed(
			"error",
			error ||
				final?.errorMessage ||
				`Subagent ended without a complete response (${final?.stopReason ?? "no response"}).`,
		);
	const last = final ? contentText(final.content) : "";
	if (!reportOf) return done(last);
	return {
		...failed("error", UNREPORTED),
		output: last ? `${UNREPORTED} Its last message:\n\n${last}` : UNREPORTED,
		unreported: true,
	};
}
