import { setImmediate } from "node:timers/promises";
import type {
	AgentToolResult,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	CreateAgentSessionOptions,
	ExtensionError,
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./errors.ts";
import {
	type RunSummary,
	SUBAGENT_USAGE_KIND,
	summarizeOwnUsage,
	summarizeRun,
} from "./summary.ts";

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

export interface Leftover {
	readonly label: string;
	running(): boolean;
	detach(): void;
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
}

export const ROOT = "root";

export type Notice = Parameters<AgentSession["sendCustomMessage"]>[0];

export interface SubagentToolExecution {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: AgentToolResult<unknown>;
	status: "running" | "done" | "error";
	parentToolCallId?: string;
}

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

interface ActiveRun {
	readonly userLed: boolean;
	reminded: boolean;
	reminder?: Promise<void>;
	preflight: Promise<void>;
	settled: Promise<void>;
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
	unsubscribe: () => void;
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

type ToolExecutionEvent = Extract<
	AgentSessionEvent,
	{ type: `tool_execution_${"start" | "update" | "end"}` }
>;

function isToolExecution(
	event: AgentSessionEvent,
): event is ToolExecutionEvent {
	return (
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	);
}

function toolSnapshot(
	event: ToolExecutionEvent,
	previous: SubagentToolExecution | undefined,
): SubagentToolExecution {
	const call = {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		parentToolCallId: event.parentToolCallId ?? previous?.parentToolCallId,
	};
	switch (event.type) {
		case "tool_execution_start":
			return { ...call, args: event.args, status: "running" };
		case "tool_execution_update":
			return {
				...call,
				args: event.args,
				result: event.partialResult,
				status: "running",
			};
		case "tool_execution_end":
			return {
				...call,
				args: previous?.args,
				result: event.result,
				status: event.isError ? "error" : "done",
			};
	}
}

export function createSubagents({
	createSession,
	remindSession,
	disposeSession,
	reportOf,
	rootSessionManager,
}: SubagentsOptions): Subagents {
	const rootLedger = rootSessionManager && usageLedger(rootSessionManager);
	const nodes = new Map<string, SubagentNode>();
	const completions = new Map<string, Set<Promise<void>>>();
	const handles = new Map<Promise<void>, Leftover>();
	const completionErrors: unknown[] = [];
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
		else completionErrors.push(error);
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
		const index = childrenOf(parentId).length + 1;
		const id = parentId === ROOT ? `${index}` : `${parentId}.${index}`;
		const node: SubagentNode = {
			id,
			parentId,
			depth: (parent?.depth ?? 0) + 1,
			instructions,
			context,
			status: "running",
			cancelled: false,
			unsubscribe: () => {},
			liveTools: new Map(),
			pendingInput: new Set(),
			queuedNotices: new Set(),
			heldNotices: [],
			get interrupted() {
				return node.interruption !== undefined;
			},
			get delegated() {
				return node.run !== undefined && !node.run.userLed;
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
		const result = run(node, instructions);
		void result.catch(() => {});
		return { id, result };
	}

	function trackCompletion(
		parentId: string,
		completion: Promise<void>,
		leftover?: Leftover,
	): void {
		const pending = completions.get(parentId) ?? new Set();
		completions.set(parentId, pending);
		pending.add(completion);
		if (leftover) handles.set(completion, leftover);
		const remove = () => {
			pending.delete(completion);
			handles.delete(completion);
			if (!pending.size && completions.get(parentId) === pending)
				completions.delete(parentId);
			const node = nodes.get(parentId);
			if (node?.run && completion !== node.run.reminder)
				node.run.reminded = false;
		};
		void completion.then(remove, (error: unknown) => {
			fail(parentId, error);
			remove();
		});
	}

	async function settled(parentId: string): Promise<void> {
		for (
			let pending = completions.get(parentId);
			pending?.size;
			pending = completions.get(parentId)
		)
			await Promise.allSettled(pending);
	}

	function submit(
		node: SubagentNode,
		active: ActiveRun,
		instructions: string,
		fromUser: boolean,
	): Promise<void> {
		const previous = active.preflight;
		const preflight = Promise.withResolvers<void>();
		active.preflight = preflight.promise;
		const input = { text: instructions };
		if (fromUser) node.pendingInput.add(input);
		const accepted = (disposition?: string) => {
			const withdrawn = fromUser && !node.pendingInput.delete(input);
			if (withdrawn && disposition === "queued") clearQueue(node);
			releaseHeld(node);
			preflight.resolve();
		};
		const live = () =>
			!node.cancelled &&
			!closing &&
			(!fromUser || node.pendingInput.has(input));
		const prompt = previous.then(async () => {
			try {
				if (fromUser && node.interruption && live())
					await node.session?.waitForIdle();
				const session = node.session;
				if (!session || !live()) return;
				if (fromUser) endInterruption(node);
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
			const prompt = submit(node, node.run, instructions, true);
			changed();
			await prompt;
			changed();
		} else await run(node, instructions, true);
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
			throw error;
		}
	}

	async function run(
		node: SubagentNode,
		instructions: string,
		userLed = false,
	): Promise<SubagentResult> {
		node.cancelled = false;
		node.status = "running";
		node.error = undefined;
		node.liveTools.clear();
		const initialization = Promise.withResolvers<void>();
		const settlement = Promise.withResolvers<void>();
		const active: ActiveRun = {
			userLed,
			reminded: false,
			preflight: initialization.promise,
			settled: settlement.promise,
		};
		node.run = active;
		const ledgers: UsageLedger[] = rootLedger ? [rootLedger] : [];
		for (const ancestor of ancestors(nodes, node)) {
			if (ancestor.session)
				ledgers.push(usageLedger(ancestor.session.sessionManager));
			if (ancestor.run) trackCompletion(ancestor.id, active.settled);
		}
		trackCompletion(ROOT, active.settled);
		let firstEntry = node.session?.sessionManager.getEntries().length;
		void submit(node, active, instructions, userLed);
		const finish = () => {
			if (node.run === active) node.run = undefined;
			settlement.resolve();
		};
		try {
			changed();
			try {
				await setImmediate();
				if (!node.session && !node.cancelled && !closing)
					await initialize(node);
				if (node.cancelled || closing) abort(node.id);
				if (node.session)
					firstEntry ??= node.session.sessionManager.getEntries().length;
			} catch (error) {
				recordError(node, error);
			} finally {
				initialization.resolve();
			}

			const taskReportOf = active.userLed ? undefined : reportOf;
			let entries: SessionEntry[];
			let summary: RunSummary & { unreported: boolean };
			for (;;) {
				try {
					do {
						await settled(node.id);
						await node.session?.waitForIdle();
					} while (
						completions.get(node.id)?.size ||
						node.session?.isIdle === false
					);
				} catch (error) {
					recordError(node, error);
				}
				if (node.interruption) {
					await node.interruption.promise;
					continue;
				}
				entries =
					node.session?.sessionManager.getEntries().slice(firstEntry ?? 0) ??
					[];
				summary = summarizeRun(entries, {
					cancelled: node.cancelled,
					error: node.error,
					reportOf: taskReportOf,
				});
				if (
					!summary.unreported ||
					active.reminded ||
					!node.session ||
					node.cancelled ||
					closing
				)
					break;
				active.reminded = true;
				active.reminder = Promise.resolve(node.session).then(remindSession);
				trackCompletion(node.id, active.reminder);
			}
			try {
				bill(ledgers, node, summarizeOwnUsage(entries));
			} finally {
				node.status = summary.status;
				node.error = summary.error;
				finish();
				changed();
			}
			const { status, error, output, usage } = summary;
			return { id: node.id, status, error, output, usage };
		} finally {
			initialization.resolve();
			finish();
		}
	}

	function leftovers(id: string): Leftovers {
		const work: Leftover[] = [];
		for (const completion of completions.get(id) ?? []) {
			const leftover = handles.get(completion);
			if (leftover?.running()) work.push(leftover);
		}
		return {
			children: childrenOf(id)
				.filter((child) => child.delegated && !child.cancelled)
				.map((child) => child.id),
			work,
		};
	}

	function attach(node: SubagentNode, session: AgentSession): void {
		node.unsubscribe();
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
			if (isToolExecution(event))
				node.liveTools.set(
					event.toolCallId,
					toolSnapshot(event, node.liveTools.get(event.toolCallId)),
				);
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
			completionErrors.push(error);
		} finally {
			try {
				node.unsubscribe();
			} catch (error) {
				completionErrors.push(error);
			}
			node.unsubscribe = () => {};
		}
	}

	function stopSession(session: AgentSession): void {
		try {
			trackCompletion(ROOT, session.abort());
		} catch (error) {
			completionErrors.push(error);
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
			completionErrors.push(error);
		}
		if (!node.cancelled && !closing) {
			node.heldNotices.push(...lost);
			releaseHeld(node);
		}
		return input;
	}

	function withdraw(node: SubagentNode): string[] {
		const pending = Array.from(node.pendingInput, ({ text }) => text);
		node.pendingInput.clear();
		return [...clearQueue(node), ...pending];
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
			while (completions.size)
				await Promise.allSettled(
					[...completions.values()].flatMap((pending) => [...pending]),
				);
			await Promise.all(
				Array.from(nodes.values(), (node) => detach(node, node.session)),
			);
			listeners.clear();
			nodes.clear();
			completions.clear();
			if (completionErrors.length)
				throw new AggregateError(completionErrors, "Subagent cleanup failed.");
		});
		abort();
		changed();
		return closing;
	}

	const runtime: Subagents = {
		get closed() {
			return closing !== undefined;
		},
		get: (id) => nodes.get(id),
		tree: () => subagentTree(nodes.values()),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start,
		trackCompletion,
		leftovers,
		settled,
		send,
		notify,
		interrupt,
		abort,
		dispose,
	};
	return runtime;
}
