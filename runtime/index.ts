import { setImmediate } from "node:timers/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	CreateAgentSessionOptions,
	ExtensionError,
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./errors.ts";
import { type SubagentToolExecution, updateLiveTools } from "./live-tools.ts";
import { createPendingWork, type Leftover } from "./pending-work.ts";
import {
	type RunSummary,
	SUBAGENT_USAGE_KIND,
	summarizeOwnUsage,
	summarizeRun,
} from "./summary.ts";

export type { SubagentToolExecution } from "./live-tools.ts";
export type { Leftover } from "./pending-work.ts";

export interface SpawnContext
	extends Pick<CreateAgentSessionOptions, "agentDir" | "modelRuntime"> {
	cwd: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	projectTrusted: boolean;
	parentSession?: string;
}

export interface SessionOwner {
	runtime: Subagents;
	id: string;
}

export interface Leftovers {
	children: string[];
	work: Leftover[];
}

export interface SessionRequest {
	context: SpawnContext;
	owner: SessionOwner;
	onCreated: (session: AgentSession) => void;
	onError: (error: ExtensionError) => void;
}

export interface SubagentsOptions {
	createSession: (request: SessionRequest) => Promise<void>;
	remindSession: (session: AgentSession) => Promise<void>;
	disposeSession: (session: AgentSession) => Promise<void>;
	reportOf: (entry: SessionEntry) => string | undefined;
	rootSessionManager?: SessionManager;
	maxDepth?: number;
}

export const ROOT = "root";

export type Notice = Parameters<AgentSession["sendCustomMessage"]>[0];

export interface Subagent {
	readonly id: string;
	readonly parentId: string;
	readonly depth: number;
	readonly instructions: string;
	readonly session?: AgentSession;
	readonly context: SpawnContext;
	readonly status: "running" | RunSummary["status"];
	readonly error?: string;
	readonly cancelled: boolean;
	readonly interrupted: boolean;
	readonly delegated: boolean;
	readonly liveTools: ReadonlyMap<string, SubagentToolExecution>;
	readonly queuedInput: readonly string[];
}

export interface SubagentResult extends RunSummary {
	id: string;
}

export interface Subagents {
	readonly closed: boolean;
	readonly maxDepth: number;
	canSpawn(parentId: string): boolean;
	get(id: string): Subagent | undefined;
	tree(): Subagent[];
	subscribe(listener: () => void): () => void;
	start(
		parentId: string,
		instructions: string,
		context: SpawnContext,
	): { id: string; result: Promise<SubagentResult> };
	trackCompletion(
		parentId: string,
		completion: Promise<void>,
		leftover?: Leftover,
	): void;
	leftovers(id: string): Leftovers;
	settled(parentId: string): Promise<void>;
	send(id: string, instructions: string): Promise<void>;
	notify(
		id: string,
		notice: Notice,
		deliverAs: "steer" | "followUp",
	): Promise<void>;
	interrupt(id: string): readonly string[];
	abort(id?: string): ReadonlyMap<string, readonly string[]>;
	dispose(): Promise<void>;
}

type InputOrigin = "parent" | "user";

interface ActiveRun {
	readonly origin: InputOrigin;
	reminded: boolean;
	preflight: Promise<unknown>;
}

interface SubagentNode extends Subagent {
	session?: AgentSession;
	status: Subagent["status"];
	error?: string;
	cancelled: boolean;
	interruption?: PromiseWithResolvers<void>;
	readonly liveTools: Map<string, SubagentToolExecution>;
	readonly pendingInput: Set<{ readonly text: string }>;
	readonly queuedNotices: Set<Notice>;
	readonly heldNotices: Notice[];
	run?: ActiveRun;
	unsubscribe?: () => void;
}

interface UsageLedger {
	manager: SessionManager;
	sessionId: string;
}

function usageLedger(manager: SessionManager): UsageLedger {
	return { manager, sessionId: manager.getSessionId() };
}

function subagentTree(nodes: Iterable<Subagent>): Subagent[] {
	const children = Map.groupBy(nodes, (node) => node.parentId);
	const visit = (id: string): Subagent[] =>
		(children.get(id) ?? []).flatMap((node) => [node, ...visit(node.id)]);
	return visit(ROOT);
}

function* ancestors<Node extends Subagent>(
	nodes: ReadonlyMap<string, Node>,
	node: Subagent,
): Generator<Node> {
	for (
		let parent = nodes.get(node.parentId);
		parent;
		parent = nodes.get(parent.parentId)
	)
		yield parent;
}

function isWithin(
	nodes: ReadonlyMap<string, Subagent>,
	node: Subagent,
	id: string,
): boolean {
	return (
		id === ROOT ||
		[node, ...ancestors(nodes, node)].some((member) => member.id === id)
	);
}

function bill(
	ledgers: readonly UsageLedger[],
	node: Subagent,
	usage: Usage,
): void {
	const { provider, id } = node.context.model;
	for (const { manager, sessionId } of ledgers)
		if (manager.getSessionId() === sessionId)
			manager.appendUsage(SUBAGENT_USAGE_KIND, provider, id, usage, node.id);
}

function recordError(node: SubagentNode, error: unknown): void {
	node.error ??= errorMessage(error);
}

export function createSubagents({
	createSession,
	remindSession,
	disposeSession,
	reportOf,
	rootSessionManager,
	maxDepth = Number.POSITIVE_INFINITY,
}: SubagentsOptions): Subagents {
	if (!(maxDepth >= 1 && (Number.isInteger(maxDepth) || maxDepth === Infinity)))
		throw new RangeError(`Invalid subagent max depth: ${maxDepth}`);
	const rootLedger = rootSessionManager && usageLedger(rootSessionManager);
	const nodes = new Map<string, SubagentNode>();
	const pending = createPendingWork(fail);
	const cleanupErrors: unknown[] = [];
	const listeners = new Set<() => void>();
	let closing: Promise<void> | undefined;

	function changed(): void {
		for (const listener of listeners) listener();
	}

	function assertOpen(): void {
		if (closing) throw new Error("Subagents have been shut down.");
	}

	function childrenOf(id: string): SubagentNode[] {
		return [...nodes.values()].filter((node) => node.parentId === id);
	}

	function fail(id: string, error: unknown): void {
		const node = nodes.get(id);
		if (node?.run) recordError(node, error);
		else cleanupErrors.push(error);
	}

	function start(
		parentId: string,
		instructions: string,
		context: SpawnContext,
	) {
		assertOpen();
		if (!instructions.trim())
			throw new Error("Subagent instructions must not be empty.");
		const parent = nodes.get(parentId);
		if (parentId !== ROOT && !parent)
			throw new Error(`Unknown parent: ${parentId}`);
		if (parent?.cancelled) throw new Error(`Parent ${parentId} was aborted.`);
		const depth = (parent?.depth ?? 0) + 1;
		if (depth > maxDepth)
			throw new Error(
				`Subagent depth limit reached: ${parentId} is at the maximum depth (${maxDepth}).`,
			);
		const index = childrenOf(parentId).length + 1;
		const id = parentId === ROOT ? `${index}` : `${parentId}.${index}`;
		const node: SubagentNode = {
			id,
			parentId,
			depth,
			instructions,
			context,
			status: "running",
			cancelled: false,
			liveTools: new Map(),
			pendingInput: new Set(),
			queuedNotices: new Set(),
			heldNotices: [],
			get interrupted() {
				return node.interruption !== undefined;
			},
			get delegated() {
				return node.run?.origin === "parent";
			},
			get queuedInput() {
				return [
					...(node.session?.getSteeringMessages() ?? []),
					...(node.session?.getFollowUpMessages() ?? []),
					...Array.from(node.pendingInput, ({ text }) => text),
				];
			},
		};
		nodes.set(id, node);
		const result = run(node, instructions, "parent");
		void result.catch(() => {});
		return { id, result };
	}

	function trackCompletion(
		parentId: string,
		completion: Promise<void>,
		leftover?: Leftover,
	): void {
		const run = nodes.get(parentId)?.run;
		if (run) run.reminded = false;
		pending.track(parentId, completion, leftover);
	}

	function submit(
		node: SubagentNode,
		active: ActiveRun,
		instructions: string,
		origin: InputOrigin,
	): Promise<void> {
		const previous = active.preflight;
		const preflight = Promise.withResolvers<void>();
		active.preflight = preflight.promise;
		const input = origin === "user" ? { text: instructions } : undefined;
		if (input) node.pendingInput.add(input);
		const accepted = (disposition?: string) => {
			const withdrawn = input && !node.pendingInput.delete(input);
			if (withdrawn && disposition === "queued") clearQueue(node);
			releaseHeld(node);
			preflight.resolve();
		};
		const live = () =>
			!node.cancelled && !closing && (!input || node.pendingInput.has(input));
		const prompt = previous.then(async () => {
			try {
				if (input && node.interruption && live())
					await node.session?.waitForIdle();
				const session = node.session;
				if (!session || !live()) return;
				if (input) endInterruption(node);
				await session.prompt(instructions, {
					streamingBehavior: "steer",
					preflightResult: accepted,
				});
			} finally {
				accepted();
			}
		});
		trackCompletion(node.id, prompt);
		return prompt;
	}

	async function send(id: string, instructions: string): Promise<void> {
		assertOpen();
		const node = nodes.get(id);
		if (!node) throw new Error(`Unknown subagent: ${id}`);
		if (!instructions.trim()) return;
		if (node.run) {
			if (node.cancelled) throw new Error(`Subagent ${id} is stopping.`);
			const prompt = submit(node, node.run, instructions, "user");
			changed();
			await prompt;
			changed();
		} else await run(node, instructions, "user");
	}

	function wake(
		node: SubagentNode,
		session: AgentSession,
		notice: Notice,
		deliverAs: "steer" | "followUp",
	): Promise<void> {
		if (session.isStreaming) node.queuedNotices.add(notice);
		return session.sendCustomMessage(notice, { deliverAs, triggerTurn: true });
	}

	async function notify(
		id: string,
		notice: Notice,
		deliverAs: "steer" | "followUp",
	): Promise<void> {
		const node = nodes.get(id);
		const session = node?.session;
		if (!node || !session) throw new Error(`Subagent ${id} has no session.`);
		if (node.cancelled || closing) return;
		if (node.interruption) {
			node.heldNotices.push(notice);
			return;
		}
		await wake(node, session, notice, deliverAs);
	}

	function releaseHeld(node: SubagentNode): void {
		const session = node.session;
		if (!session || node.interruption) return;
		for (const notice of node.heldNotices.splice(0))
			trackCompletion(node.id, wake(node, session, notice, "steer"));
	}

	function endInterruption(node: SubagentNode): void {
		const interruption = node.interruption;
		if (!interruption) return;
		node.interruption = undefined;
		interruption.resolve();
		changed();
	}

	async function initialize(node: SubagentNode): Promise<void> {
		try {
			await createSession({
				context: node.context,
				owner: { runtime, id: node.id },
				onCreated: (session) => attach(node, session),
				onError: ({ error }) => {
					fail(node.id, new Error(error));
					changed();
				},
			});
		} catch (error) {
			recordError(node, error);
			const session = node.session;
			node.session = undefined;
			if (session) await detach(node, session);
		}
	}

	async function prepareRun(node: SubagentNode): Promise<number> {
		let firstEntry: number | undefined;
		try {
			firstEntry = node.session?.sessionManager.getEntries().length;
			// Publish the running receipt before loading the child session.
			await setImmediate();
			if (!node.session && !node.cancelled && !closing) await initialize(node);
			if (node.cancelled || closing) abort(node.id);
			firstEntry ??= node.session?.sessionManager.getEntries().length;
		} catch (error) {
			recordError(node, error);
		}
		return firstEntry ?? 0;
	}

	async function run(
		node: SubagentNode,
		instructions: string,
		origin: InputOrigin,
	): Promise<SubagentResult> {
		node.cancelled = false;
		node.status = "running";
		node.error = undefined;
		node.liveTools.clear();
		const ready = prepareRun(node);
		const active: ActiveRun = {
			origin,
			reminded: false,
			preflight: ready,
		};
		const settlement = Promise.withResolvers<void>();
		node.run = active;
		const ledgers: UsageLedger[] = rootLedger ? [rootLedger] : [];
		for (const ancestor of ancestors(nodes, node)) {
			if (ancestor.session)
				ledgers.push(usageLedger(ancestor.session.sessionManager));
			if (ancestor.run) trackCompletion(ancestor.id, settlement.promise);
		}
		trackCompletion(ROOT, settlement.promise);
		void submit(node, active, instructions, origin);
		try {
			changed();
			const firstEntry = await ready;
			for (;;) {
				try {
					await pending.settled(node.id);
					await node.session?.waitForIdle();
					if (pending.has(node.id) || node.session?.isIdle === false) continue;
				} catch (error) {
					recordError(node, error);
				}
				if (node.interruption) {
					await node.interruption.promise;
					continue;
				}
				const entries =
					node.session?.sessionManager.getEntries().slice(firstEntry) ?? [];
				const { unreported, ...summary } = summarizeRun(entries, {
					cancelled: node.cancelled,
					error: node.error,
					reportOf: origin === "parent" ? reportOf : undefined,
				});
				if (unreported && !active.reminded && node.session && !closing) {
					active.reminded = true;
					// Wait for the reminder without counting it as new work to remind about.
					pending.track(
						node.id,
						Promise.resolve(node.session).then(remindSession),
					);
					continue;
				}
				node.status = summary.status;
				node.error = summary.error;
				bill(ledgers, node, summarizeOwnUsage(entries));
				return { id: node.id, ...summary };
			}
		} finally {
			node.run = undefined;
			settlement.resolve();
			changed();
		}
	}

	function leftovers(id: string): Leftovers {
		return {
			children: childrenOf(id)
				.filter((child) => child.delegated && !child.cancelled)
				.map((child) => child.id),
			work: pending.running(id),
		};
	}

	function attach(node: SubagentNode, session: AgentSession): void {
		node.unsubscribe?.();
		node.session = session;
		node.unsubscribe = session.subscribe((event) => {
			if ((node.cancelled || node.interruption) && event.type === "agent_start")
				stopSession(session);
			if (event.type === "message_end" && event.message.role === "custom")
				for (const notice of node.queuedNotices)
					if (
						notice.content === event.message.content &&
						notice.details === event.message.details
					)
						node.queuedNotices.delete(notice);
			updateLiveTools(node.liveTools, event);
			changed();
		});
		changed();
	}

	async function detach(
		node: SubagentNode,
		session: AgentSession | undefined,
	): Promise<void> {
		try {
			if (session) await disposeSession(session);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			node.unsubscribe?.();
		} catch (error) {
			cleanupErrors.push(error);
		}
		node.unsubscribe = undefined;
	}

	function stopSession(session: AgentSession): void {
		try {
			trackCompletion(ROOT, session.abort());
		} catch (error) {
			cleanupErrors.push(error);
		}
	}

	function clearQueue(node: SubagentNode): string[] {
		const lost = [...node.queuedNotices];
		node.queuedNotices.clear();
		let input: string[] = [];
		try {
			const queued = node.session?.clearQueue();
			if (queued) input = [...queued.steering, ...queued.followUp];
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (!node.cancelled && !closing) {
			node.heldNotices.push(...lost);
			releaseHeld(node);
		}
		return input;
	}

	function withdraw(node: SubagentNode): string[] {
		const input = Array.from(node.pendingInput, ({ text }) => text);
		node.pendingInput.clear();
		return [...clearQueue(node), ...input];
	}

	function interrupt(id: string): string[] {
		const node = nodes.get(id);
		if (
			node?.status !== "running" ||
			node.cancelled ||
			node.interruption ||
			closing
		)
			return [];
		node.interruption = Promise.withResolvers();
		const input = withdraw(node);
		if (node.session) stopSession(node.session);
		changed();
		return input;
	}

	function abort(id = ROOT): Map<string, string[]> {
		const discarded = new Map<string, string[]>();
		for (const node of nodes.values()) {
			if (!isWithin(nodes, node, id) || node.status !== "running") continue;
			node.cancelled = true;
			node.heldNotices.length = 0;
			endInterruption(node);
			const input = withdraw(node);
			if (input.length) discarded.set(node.id, input);
			if (node.session) stopSession(node.session);
			changed();
		}
		return discarded;
	}

	function dispose(): Promise<void> {
		if (closing) return closing;
		closing = Promise.resolve().then(async () => {
			await pending.settleAll();
			await Promise.all(
				Array.from(nodes.values(), (node) => detach(node, node.session)),
			);
			listeners.clear();
			nodes.clear();
			if (cleanupErrors.length)
				throw new AggregateError(cleanupErrors, "Subagent cleanup failed.");
		});
		abort();
		changed();
		return closing;
	}

	const runtime: Subagents = {
		get closed() {
			return closing !== undefined;
		},
		maxDepth,
		canSpawn: (parentId) => (nodes.get(parentId)?.depth ?? 0) < maxDepth,
		get: (id) => nodes.get(id),
		tree: () => subagentTree(nodes.values()),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start,
		trackCompletion,
		leftovers,
		settled: pending.settled,
		send,
		notify,
		interrupt,
		abort,
		dispose,
	};
	return runtime;
}
