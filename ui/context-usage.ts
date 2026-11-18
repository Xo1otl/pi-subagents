import type {
	AgentSession,
	ContextUsage,
} from "@earendil-works/pi-coding-agent";
import type { UITheme } from "./text.ts";

interface CachedContextUsage {
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	model: AgentSession["model"];
	usage: ContextUsage | undefined;
}

const cache = new WeakMap<AgentSession, CachedContextUsage>();

export function readContextUsage(
	session: AgentSession | undefined,
): ContextUsage | undefined {
	if (!session) return undefined;
	const manager = session.sessionManager;
	const sessionId = manager.getSessionId();
	const leafId = manager.getLeafId();
	const entryCount = manager.getEntryCount();
	const model = session.routedModel?.model ?? session.model;
	const previous = cache.get(session);
	if (
		previous &&
		previous.sessionId === sessionId &&
		previous.leafId === leafId &&
		previous.entryCount === entryCount &&
		previous.model === model
	)
		return previous.usage;
	const usage = session.getContextUsage();
	cache.set(session, { sessionId, leafId, entryCount, model, usage });
	return usage;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function describeUsage(
	usage: ContextUsage | undefined,
	percentage: string | undefined,
): string {
	if (!usage) return "ctx ?";
	const tokens = usage.tokens === null ? "?" : formatTokens(usage.tokens);
	const share = percentage ? ` (${percentage})` : "";
	return `ctx ${tokens}/${formatTokens(usage.contextWindow)}${share}`;
}

export function renderContextUsage(
	usage: ContextUsage | undefined,
	theme: UITheme,
	compact = false,
): string {
	const percent = usage?.percent ?? undefined;
	const percentage =
		percent === undefined ? undefined : `${percent.toFixed(1)}%`;
	const text = compact ? (percentage ?? "?") : describeUsage(usage, percentage);
	const pressure = percent ?? 0;
	return theme.fg(
		pressure > 90 ? "error" : pressure > 70 ? "warning" : "dim",
		text,
	);
}
