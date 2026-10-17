import { afterEach, expect, test } from "bun:test";
import type { Provider, Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSubagentIntegration } from "../agent/index.ts";
import { SUBAGENT_RESULT_TYPE } from "../agent/protocol.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import { SUBAGENT_USAGE_KIND } from "../runtime/summary.ts";
import {
	deferred,
	hierarchyStream,
	lastText,
	model,
	parentSession,
	response,
	stream,
	until,
	waiting,
} from "./fixtures.ts";

const parents: { session: AgentSession; tree: Subagents }[] = [];
afterEach(async () => {
	for (const { session, tree } of parents.splice(0)) {
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		await tree.dispose();
		session.dispose();
	}
});

async function setup(dispatch: Provider["streamSimple"]) {
	let tree: Subagents | undefined;
	const view = {
		bind(runtime: Subagents) {
			tree = runtime;
		},
		dispose() {},
	};
	const session = await parentSession(dispatch, [
		(pi) => pi.registerTool(createSubagentIntegration(pi, view)),
	]);
	if (!tree) throw new Error("Missing root runtime");
	parents.push({ session, tree });
	return { session, tree };
}

function charges(session: AgentSession) {
	return session.sessionManager
		.getEntries()
		.filter(
			(entry) => entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND,
		);
}

async function settled(session: AgentSession, tree: Subagents) {
	await tree.settled(ROOT);
	await session.waitForIdle();
}

const resumedUsage: Usage = {
	input: 2,
	output: 3,
	cacheRead: 4,
	cacheWrite: 5,
	totalTokens: 14,
	reasoning: 2,
	cacheWrite1h: 1,
	cost: {
		input: 0.02,
		output: 0.03,
		cacheRead: 0.04,
		cacheWrite: 0.05,
		total: 0.14,
	},
};

function expectDelta(
	session: AgentSession,
	before: ReturnType<AgentSession["getSessionStats"]>,
	usage: Usage,
) {
	const after = session.getSessionStats();
	expect(after.tokens).toEqual({
		input: before.tokens.input + usage.input,
		output: before.tokens.output + usage.output,
		cacheRead: before.tokens.cacheRead + usage.cacheRead,
		cacheWrite: before.tokens.cacheWrite + usage.cacheWrite,
		total: before.tokens.total + usage.totalTokens,
	});
	expect(after.cost).toBeCloseTo(before.cost + usage.cost.total);
}

test.each(["done", "aborted"] as const)(
	"resuming a %s child bills each new run without notifying or recharging the parent",
	async (status) => {
		const dispatch = stream((context, options) => {
			const text = lastText(context);
			if (text === "nest:0" && status === "aborted")
				return waiting(options?.signal);
			if (text === "resume")
				return response("resumed", { usage: resumedUsage });
			return hierarchyStream(model, context, options).result();
		});
		const { session, tree } = await setup(dispatch);
		await session.prompt("nest:1");
		if (status === "aborted") {
			await until(() => Boolean(tree.get("1")?.session?.isStreaming));
			tree.abort("1");
		}
		await settled(session, tree);
		expect(tree.get("1")?.status).toBe(status);
		expect(charges(session)).toHaveLength(1);
		const messages = JSON.stringify(session.messages);
		const child = tree.get("1")?.session;
		if (!child) throw new Error("Missing child");
		for (let run = 0; run < 2; run++) {
			const before = session.getSessionStats();
			await tree.send("1", "resume");
			expect(tree.get("1")?.session).toBe(child);
			expect(tree.get("1")?.status).toBe("done");
			expectDelta(session, before, resumedUsage);
			expect(charges(session)).toHaveLength(run + 2);
			expect(charges(session).at(-1)).toMatchObject({
				note: "1",
				usage: resumedUsage,
			});
			expect(JSON.stringify(session.messages)).toBe(messages);
		}
	},
);

test("resumed nested descendants bill all idle ancestors exactly once", async () => {
	const dispatch = stream((context, options) =>
		lastText(context) === "resume"
			? response("resumed", { usage: resumedUsage })
			: hierarchyStream(model, context, options).result(),
	);
	const { session, tree } = await setup(dispatch);
	await session.prompt("nest:3");
	await settled(session, tree);
	const ancestors = [session, tree.get("1")?.session, tree.get("1.1")?.session];
	const leaf = tree.get("1.1.1")?.session;
	if (!leaf || ancestors.some((ancestor) => !ancestor))
		throw new Error("Missing hierarchy");
	for (let run = 0; run < 2; run++) {
		const snapshots = ancestors.map((ancestor) => {
			if (!ancestor) throw new Error("Missing ancestor");
			return {
				ancestor,
				stats: ancestor.getSessionStats(),
				messages: JSON.stringify(ancestor.messages),
			};
		});
		await tree.send("1.1.1", "resume");
		for (const { ancestor, stats, messages } of snapshots) {
			expectDelta(ancestor, stats, resumedUsage);
			expect(charges(ancestor).at(-1)).toMatchObject({
				note: "1.1.1",
				usage: resumedUsage,
			});
			expect(JSON.stringify(ancestor.messages)).toBe(messages);
		}
	}
});

test("a resumed parent that delegates again bills only new local and descendant work", async () => {
	const { session, tree } = await setup(hierarchyStream);
	await session.prompt("nest:2");
	await settled(session, tree);
	const parent = tree.get("1")?.session;
	if (!parent) throw new Error("Missing child parent");
	const rootBefore = session.getSessionStats();
	const childBefore = parent.getSessionStats();
	const messages = JSON.stringify(session.messages);
	await tree.send("1", "nest:1");
	// Three local responses (tool call, receipt, completion) plus one descendant.
	const newUsage = {
		...response("").usage,
		input: 4,
		output: 8,
		totalTokens: 12,
		cost: {
			input: 0.04,
			output: 0.08,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.12,
		},
	};
	expectDelta(session, rootBefore, newUsage);
	expectDelta(parent, childBefore, newUsage);
	expect(tree.get("1.2")?.status).toBe("done");
	expect(JSON.stringify(session.messages)).toBe(messages);
	const latestCharges = charges(session).slice(-2);
	expect(
		latestCharges.map(
			(entry) =>
				entry.type === "usage" && [entry.note, entry.usage.totalTokens],
		),
	).toEqual([
		["1.2", 3],
		["1", 9],
	]);
});

test("a running ancestor drains a resumed descendant through an idle intermediate parent", async () => {
	const gate = deferred();
	const entered = deferred();
	const dispatch = stream(async (context, options) => {
		if (lastText(context) === "slow resume") {
			entered.resolve();
			await Promise.race([gate.promise, waiting(options?.signal)]);
			return response("resumed", { usage: resumedUsage });
		}
		return hierarchyStream(model, context, options).result();
	});
	const { session, tree } = await setup(dispatch);
	await session.prompt("nest:3");
	await settled(session, tree);
	let resumed: Promise<void> | undefined;
	let ancestor: Promise<void> | undefined;
	let completed = false;
	let requested = false;
	const rootBefore = session.getSessionStats();
	const messages = JSON.stringify(session.messages);
	const unsubscribe = tree.subscribe(() => {
		if (tree.get("1")?.status === "running" && !requested) {
			requested = true;
			resumed = tree.send("1.1.1", "slow resume");
		}
	});
	try {
		ancestor = tree.send("1", "continue ancestor").then(() => {
			completed = true;
		});
		await entered.promise;
		await until(() => Boolean(tree.get("1")?.session?.isIdle));
		await Bun.sleep(10);
		expect(completed).toBe(false);
		gate.resolve();
		await resumed;
		await ancestor;
		expectDelta(session, rootBefore, {
			...resumedUsage,
			input: resumedUsage.input + 1,
			output: resumedUsage.output + 2,
			totalTokens: resumedUsage.totalTokens + 3,
			cost: { ...resumedUsage.cost, total: resumedUsage.cost.total + 0.03 },
		});
		expect(JSON.stringify(session.messages)).toBe(messages);
		expect(
			session.messages.filter(
				(message) =>
					message.role === "custom" &&
					message.customType === SUBAGENT_RESULT_TYPE,
			),
		).toHaveLength(1);
	} finally {
		unsubscribe();
		gate.resolve();
		await resumed;
		await ancestor;
	}
});

test("stopping a resumed run preserves its charges without a late parent notification", async () => {
	const dispatch = stream((context, options) =>
		lastText(context) === "slow resume"
			? waiting(options?.signal)
			: hierarchyStream(model, context, options).result(),
	);
	const { session, tree } = await setup(dispatch);
	await session.prompt("nest:1");
	await settled(session, tree);
	const before = session.getSessionStats();
	const messages = JSON.stringify(session.messages);
	const resumed = tree.send("1", "slow resume");
	await until(() => Boolean(tree.get("1")?.session?.isStreaming));
	tree.abort("1");
	await resumed;
	expectDelta(session, before, response("").usage);
	expect(charges(session)).toHaveLength(2);
	expect(JSON.stringify(session.messages)).toBe(messages);
});

test("resumed billing remains fenced from a replacement root ledger", async () => {
	const { session, tree } = await setup(hierarchyStream);
	await session.prompt("nest:1");
	await settled(session, tree);
	const oldId = session.sessionManager.getSessionId();
	// Simulate replacing the captured manager without relying on a shutdown event.
	session.sessionManager.newSession();
	expect(session.sessionManager.getSessionId()).not.toBe(oldId);
	await tree.send("1", "resume");
	expect(charges(session)).toHaveLength(0);
	expect(session.getSessionStats().tokens.total).toBe(0);
});
