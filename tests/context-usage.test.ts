import { expect, mock, test } from "bun:test";
import {
	type AgentSession,
	type ContextUsage,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	createContextUsageReader,
	renderContextUsage,
} from "../ui/context-usage.ts";
import { model, response } from "./fixtures.ts";

const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };

test.each([
	[undefined, "ctx ?", "?"],
	[{ tokens: null, contextWindow: 100_000, percent: null }, "ctx ?/100k", "?"],
	[
		{ tokens: 0, contextWindow: 100_000, percent: 0 },
		"ctx 0/100k (0.0%)",
		"0.0%",
	],
	[
		{ tokens: 999, contextWindow: 100_000, percent: 0.999 },
		"ctx 999/100k (1.0%)",
		"1.0%",
	],
	[
		{ tokens: 1500, contextWindow: 100_000, percent: 1.5 },
		"ctx 1.5k/100k (1.5%)",
		"1.5%",
	],
	[
		{ tokens: 32_100, contextWindow: 100_000, percent: 32.1 },
		"ctx 32k/100k (32.1%)",
		"32.1%",
	],
	[
		{ tokens: 1_500_000, contextWindow: 2_000_000, percent: 75 },
		"ctx 1.5M/2.0M (75.0%)",
		"75.0%",
	],
	[
		{ tokens: 12_000_000, contextWindow: 16_000_000, percent: 75 },
		"ctx 12M/16M (75.0%)",
		"75.0%",
	],
] as const)(
	"formats context usage %# without treating unknown as zero",
	(usage, detailed, compact) => {
		expect(renderContextUsage(usage, theme)).toBe(detailed);
		expect(renderContextUsage(usage, theme, true)).toBe(compact);
	},
);

test.each([
	[null, "dim"],
	[0, "dim"],
	[70, "dim"],
	[70.1, "warning"],
	[90, "warning"],
	[90.1, "error"],
	[125, "error"],
] as const)(
	"colors %s%% using the root footer's thresholds",
	(percent, color) => {
		const fg = mock((_color: Parameters<Theme["fg"]>[0], text: string) => text);
		const usage: ContextUsage = {
			tokens: percent === null ? null : percent * 1000,
			contextWindow: 100_000,
			percent,
		};
		for (const compact of [false, true]) {
			const text = renderContextUsage(usage, { fg }, compact);
			expect(fg).toHaveBeenLastCalledWith(color, text);
		}
		expect(
			renderContextUsage(usage, { fg: (_color, text) => text.toUpperCase() }),
		).toContain("CTX");
	},
);

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
	const read = createContextUsageReader();
	expect(read(undefined)).toBeUndefined();
	expect(read(session)).toBeUndefined();
	read(session);
	expect(getContextUsage).toHaveBeenCalledTimes(1);

	usage = { tokens: 32_100, contextWindow: 100_000, percent: 32.1 };
	const first = manager.appendMessage(response("first"));
	expect(read(session)).toBe(usage);
	expect(read(session)).toBe(usage);
	expect(getContextUsage).toHaveBeenCalledTimes(2);
	manager.appendMessage(response("second"));
	read(session);
	expect(getContextUsage).toHaveBeenCalledTimes(3);
	manager.branch(first); // Same entry count, different active context.
	read(session);
	expect(getContextUsage).toHaveBeenCalledTimes(4);

	state.model = { ...model, contextWindow: 200_000 };
	read(session);
	expect(getContextUsage).toHaveBeenCalledTimes(5);
	state.routedModel = { model: { ...model, contextWindow: 1_000_000 } };
	read(session);
	read(session);
	expect(getContextUsage).toHaveBeenCalledTimes(6);

	// Replacing an empty ledger changes its session ID, not its leaf or count.
	manager.newSession();
	read(session);
	manager.newSession();
	read(session);
	expect(getContextUsage).toHaveBeenCalledTimes(8);
	read({ ...state } as unknown as AgentSession);
	expect(getContextUsage).toHaveBeenCalledTimes(9);
});
