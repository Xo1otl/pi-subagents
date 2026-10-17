import { expect, mock, test } from "bun:test";
import {
	type AgentSession,
	type ContextUsage,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { readContextUsage, renderContextUsage } from "../ui/context-usage.ts";
import { model, response } from "./fixtures.ts";

test("formats context usage without treating unknown as zero, colored by the root footer's thresholds", () => {
	const cases: [ContextUsage | undefined, string, string, string][] = [
		[undefined, "ctx ?", "?", "dim"],
		[
			{ tokens: null, contextWindow: 100_000, percent: null },
			"ctx ?/100k",
			"?",
			"dim",
		],
		[
			{ tokens: 999, contextWindow: 100_000, percent: 0.999 },
			"ctx 999/100k (1.0%)",
			"1.0%",
			"dim",
		],
		[
			{ tokens: 1500, contextWindow: 100_000, percent: 70 },
			"ctx 1.5k/100k (70.0%)",
			"70.0%",
			"dim",
		],
		[
			{ tokens: 70_100, contextWindow: 100_000, percent: 70.1 },
			"ctx 70k/100k (70.1%)",
			"70.1%",
			"warning",
		],
		[
			{ tokens: 1_500_000, contextWindow: 2_000_000, percent: 90 },
			"ctx 1.5M/2.0M (90.0%)",
			"90.0%",
			"warning",
		],
		[
			{ tokens: 12_000_000, contextWindow: 16_000_000, percent: 90.1 },
			"ctx 12M/16M (90.1%)",
			"90.1%",
			"error",
		],
		[
			{ tokens: 125_000, contextWindow: 100_000, percent: 125 },
			"ctx 125k/100k (125.0%)",
			"125.0%",
			"error",
		],
	];
	for (const [usage, detailed, compact, color] of cases) {
		const fg = mock((_color: Parameters<Theme["fg"]>[0], text: string) => text);
		expect(renderContextUsage(usage, { fg })).toBe(detailed);
		expect(fg).toHaveBeenLastCalledWith(color, detailed);
		expect(renderContextUsage(usage, { fg }, true)).toBe(compact);
		expect(fg).toHaveBeenLastCalledWith(color, compact);
	}
});

test("context scans are cached per session, branch, entries and effective model", () => {
	const manager = SessionManager.inMemory();
	let usage: ContextUsage | undefined;
	const getContextUsage = mock(() => usage);
	const state = {
		sessionManager: manager,
		model,
		routedModel: undefined as AgentSession["routedModel"],
		getContextUsage,
	};
	const session = state as unknown as AgentSession;
	expect(readContextUsage(undefined)).toBeUndefined();
	expect(readContextUsage(session)).toBeUndefined();
	readContextUsage(session);
	expect(getContextUsage).toHaveBeenCalledTimes(1);

	usage = { tokens: 32_100, contextWindow: 100_000, percent: 32.1 };
	const first = manager.appendMessage(response("first"));
	expect(readContextUsage(session)).toBe(usage);
	expect(readContextUsage(session)).toBe(usage);
	expect(getContextUsage).toHaveBeenCalledTimes(2);
	manager.appendMessage(response("second"));
	readContextUsage(session);
	expect(getContextUsage).toHaveBeenCalledTimes(3);
	manager.branch(first); // Same entry count, different active context.
	readContextUsage(session);
	expect(getContextUsage).toHaveBeenCalledTimes(4);

	state.model = { ...model, contextWindow: 200_000 };
	readContextUsage(session);
	expect(getContextUsage).toHaveBeenCalledTimes(5);
	state.routedModel = { model: { ...model, contextWindow: 1_000_000 } };
	readContextUsage(session);
	readContextUsage(session);
	expect(getContextUsage).toHaveBeenCalledTimes(6);

	// Replacing an empty ledger changes its session ID, not its leaf or count.
	manager.newSession();
	readContextUsage(session);
	manager.newSession();
	readContextUsage(session);
	expect(getContextUsage).toHaveBeenCalledTimes(8);
	readContextUsage({ ...state } as unknown as AgentSession);
	expect(getContextUsage).toHaveBeenCalledTimes(9);
});
