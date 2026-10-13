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

/** Bill a child to the session that delegated it. The note identifies the child,
 * so summarizeRun counts it once even though the runtime also tracks it.
 */
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

function isDelegatedUsage(
	entry: SessionEntry,
	delegated: ReadonlyMap<string, Usage>,
): boolean {
	return (
		entry.type === "usage" &&
		entry.kind === SUBAGENT_USAGE_KIND &&
		Boolean(entry.note && delegated.has(entry.note))
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
	delegatedUsage: ReadonlyMap<string, Usage>,
): RunSummary {
	const messages = entries.flatMap((entry) =>
		entry.type === "message" ? [entry.message] : [],
	);
	let final: AssistantMessage | undefined;
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const message of messages) {
		if (message.role === "assistant") final = message;
	}
	const usages = [
		...messages.flatMap((message) =>
			(message.role === "assistant" || message.role === "toolResult") &&
			message.usage
				? [message.usage]
				: [],
		),
		...entries.flatMap((entry) =>
			"usage" in entry &&
			entry.usage &&
			!isDelegatedUsage(entry, delegatedUsage)
				? [entry.usage]
				: [],
		),
		// Preserve descendant billing even when cancellation suppresses delivery.
		...delegatedUsage.values(),
	];
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
