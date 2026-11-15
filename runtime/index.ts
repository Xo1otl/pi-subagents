import { setImmediate } from "node:timers/promises";
import type {
	AgentToolResult,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
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
	/** The spawning session's file; children of an ephemeral parent stay in memory. */
	parentSession?: string;
}

export interface SessionOwner {
	runtime: Subagents;
	id: string;
}

/** Work that a reporting task stops instead of waiting for. */
export interface Leftover {
	/** Names the work for the agent, e.g. a job's PGID and command. */
	readonly label: string;
	/** Stop the work, returning whether it was still running: work that
	 * already ended may still be settling, e.g. while telling of its end.
	 */
	stop(): boolean;
}

export interface SubagentsOptions {
	/** onCreated publishes the session and transfers cleanup ownership, even if
	 * initialization later rejects. Resolution signals that binding is ready.
	 * onError receives the session's extension errors, e.g. through bindExtensions.
	 */
	createSession: (
		context: SpawnContext,
		owner: SessionOwner,
		onCreated: (session: AgentSession) => void,
		onError: (error: ExtensionError) => void,
	) => Promise<void>;
	/** Start a turn that reminds an idle task, which has nothing left to wait
	 * for, to report, with a message that is not the user's. Settles with that
	 * turn.
	 */
	remindSession: (session: AgentSession) => Promise<void>;
	disposeSession: (session: AgentSession) => Promise<void>;
	/** The report an entry records, if any: the latest is a delegated task's
	 * result (see summarizeRun).
	 */
	reportOf: (entry: SessionEntry) => string | undefined;
	/** Captured root ledger; billing never follows session replacement. */
	rootSessionManager?: SessionManager;
}

export const ROOT = "root";

export interface SubagentToolExecution {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: AgentToolResult<unknown>;
	status: "running" | "done" | "error";
	parentToolCallId?: string;
}

/** Read-only view of a node; only the runtime changes it. */
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
	/** The parent's task is running, so a report reaches the parent. False
	 * between runs and while the user continues a finished conversation.
	 */
	readonly delegated: boolean;
	/** Raw execution snapshots, retained until the next delegated run. */
	readonly liveTools: ReadonlyMap<string, SubagentToolExecution>;
	/** Messages sent to this agent that have not reached its transcript;
	 * steering waits for the current step, such as a long-running tool, to finish.
	 */
	readonly queuedInput: readonly string[];
}

/** Complete run data, independent of tool output limits and presentation. */
export interface SubagentResult extends RunSummary {
	id: string;
	/** Stopped by its parent's report, which already told the parent agent. */
	leftover?: boolean;
}

export interface Subagents {
	readonly closed: boolean;
	get(id: string): Subagent | undefined;
	/** Preorder traversal of all descendants. */
	tree(): Subagent[];
	subscribe(listener: () => void): () => void;
	/** Reserve a node immediately. Invalid requests throw synchronously. */
	start(
		parentId: string,
		instructions: string,
		context: SpawnContext,
	): { id: string; result: Promise<SubagentResult> };
	/** Include asynchronous work, such as result delivery, in a parent's
	 * settlement. With a `leftover` handle, the parent's report stops it instead.
	 */
	trackCompletion(
		parentId: string,
		completion: Promise<void>,
		leftover?: Leftover,
	): void;
	/** Stop what a task left running as it reports: its delegated children
	 * and its tracked work with a leftover handle, such as jobs. Returns what
	 * was still running, by label. The children's results are not delivered.
	 */
	stopLeftovers(id: string): string[];
	/** Resolves once a parent's tracked work, including late additions, drains. */
	settled(parentId: string): Promise<void>;
	/** Steer an active run; otherwise continue the same conversation. */
	send(id: string, instructions: string): Promise<void>;
	/** Cancellation reaches the whole subtree, including user-restarted descendants.
	 * Returns the queued input it discarded, by agent, so callers can restore it.
	 */
	abort(id?: string): ReadonlyMap<string, readonly string[]>;
	dispose(): Promise<void>;
}

interface ActiveRun {
	/** Started by the user continuing a conversation, which is theirs to lead:
	 * it reports nothing.
	 */
	readonly userLed: boolean;
	/** Stopped by its parent's report, which already told the parent agent. */
	leftover: boolean;
	/** Reminded to report since the run's tracked work last changed. */
	reminded: boolean;
	reminder?: Promise<void>;
	/** Serialize input preflight, not entire prompts or delegated runs. */
	preflight: Promise<void>;
	/** Settles once the run, including descendant delivery, finishes. */
	settled: Promise<void>;
}

/** The runtime's private side of a node: these fields change, the rest is fixed. */
interface SubagentNode extends Subagent {
	session?: AgentSession;
	status: Subagent["status"];
	error?: string;
	cancelled: boolean;
	readonly liveTools: Map<string, SubagentToolExecution>;
	/** Input awaiting the session's preflight; identity distinguishes equal texts. */
	readonly pendingInput: Set<{ readonly text: string }>;
	/** Present exactly while status is "running". */
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

function belongsTo(
	nodes: ReadonlyMap<string, Subagent>,
	node: Subagent,
	ancestor: string,
): boolean {
	let current: Subagent | undefined = node;
	while (current) {
		if (current.id === ancestor || current.parentId === ancestor) return true;
		current = nodes.get(current.parentId);
	}
	return false;
}

function recordError(node: SubagentNode, error: unknown): void {
	node.error ??= errorMessage(error);
}

/** Merge one execution event into the call's raw snapshot. */
function toolSnapshot(
	event: Extract<
		AgentSessionEvent,
		{ type: `tool_execution_${"start" | "update" | "end"}` }
	>,
	previous: SubagentToolExecution | undefined,
): SubagentToolExecution {
	const ended = event.type === "tool_execution_end";
	return {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		args: ended ? previous?.args : event.args,
		parentToolCallId: event.parentToolCallId ?? previous?.parentToolCallId,
		result: ended
			? event.result
			: event.type === "tool_execution_update"
				? event.partialResult
				: undefined,
		status: ended ? (event.isError ? "error" : "done") : "running",
	};
}

/** Owns one session's mutable state; all operations are safe to pass as callbacks. */
export function createSubagents({
	createSession,
	remindSession,
	disposeSession,
	reportOf,
	rootSessionManager,
}: SubagentsOptions): Subagents {
	const rootLedger = rootSessionManager && usageLedger(rootSessionManager);
	const nodes = new Map<string, SubagentNode>();
	/** Outstanding work by the parent whose settlement includes it. */
	const completions = new Map<string, Set<Promise<void>>>();
	/** How to stop outstanding work that a report leaves over. */
	const leftovers = new Map<Promise<void>, Leftover>();
	/** Failures without a running node to own them, reported at shutdown. */
	const completionErrors: unknown[] = [];
	const listeners = new Set<() => void>();
	/** Set once shutdown begins. */
	let closing: Promise<void> | undefined;

	function changed(): void {
		for (const listener of listeners) listener();
	}

	function assertOpen(): void {
		if (closing) throw new Error("Subagents have been shut down.");
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
		// Nodes are only removed at shutdown, so sibling counts yield stable IDs.
		let count = 1;
		for (const node of nodes.values()) if (node.parentId === parentId) count++;
		const id = parentId === ROOT ? String(count) : `${parentId}.${count}`;
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
		// Observe even detached results; the original promise remains usable by callers.
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
		if (leftover) leftovers.set(completion, leftover);
		const remove = () => {
			pending.delete(completion);
			leftovers.delete(completion);
			if (!pending.size && completions.get(parentId) === pending)
				completions.delete(parentId);
			const node = nodes.get(parentId);
			// Anything but the reminder itself may have given the agent more to
			// say, e.g. input, a child's result or a job's exit.
			if (node?.run && completion !== node.run.reminder)
				node.run.reminded = false;
		};
		// Observe detached work, but retain failures even if they settle before drainage.
		void completion.then(remove, (error: unknown) => {
			const node = nodes.get(parentId);
			if (node?.run) recordError(node, error);
			else completionErrors.push(error);
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
		sent: boolean,
	): Promise<void> {
		const previous = active.preflight;
		const preflight = Promise.withResolvers<void>();
		active.preflight = preflight.promise;
		// Sent input is queued until the session queues, starts or handles it.
		const input = { text: instructions };
		if (sent) node.pendingInput.add(input);
		const accepted = (disposition?: string) => {
			const withdrawn = sent && !node.pendingInput.delete(input);
			// Stopping already handed this input back; it must not reach the agent too.
			if (withdrawn && disposition === "queued") node.session?.clearQueue();
			preflight.resolve();
		};
		const prompt = previous.then(async () => {
			try {
				if (!node.session || node.cancelled || closing) return;
				await node.session.prompt(instructions, {
					streamingBehavior: "steer",
					preflightResult: accepted,
				});
			} finally {
				accepted();
			}
		});
		// Input hooks can outlive the current session prompt and even start a new one.
		// Register before invoking them so cancellation/disposal, billing and the run's
		// drain cover both; failures become the run's error.
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

	/** Publish a node's session. A published session whose binding failed is not reusable. */
	async function initialize(node: SubagentNode): Promise<void> {
		try {
			await createSession(
				node.context,
				{ runtime, id: node.id },
				(session) => attach(node, session),
				(error) => {
					if (node.run) node.error ??= error.error;
					else completionErrors.push(new Error(error.error));
					changed();
				},
			);
		} catch (error) {
			// Record first: disposing the session can report errors of its own.
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
		sent = false,
	): Promise<SubagentResult> {
		node.cancelled = false;
		node.status = "running";
		node.error = undefined;
		node.liveTools.clear();
		const initialization = Promise.withResolvers<void>();
		const settlement = Promise.withResolvers<void>();
		// Track the whole delegated run before any lifecycle callback can request shutdown.
		const active: ActiveRun = {
			userLed: sent,
			leftover: false,
			reminded: false,
			preflight: initialization.promise,
			settled: settlement.promise,
		};
		node.run = active;
		const ledgers: UsageLedger[] = rootLedger ? [rootLedger] : [];
		// Resumed descendants belong to any active ancestors too, even when their
		// immediate parent has already completed. Idle ancestors receive billing only.
		for (
			let parent = nodes.get(node.parentId);
			parent;
			parent = nodes.get(parent.parentId)
		) {
			if (parent.session)
				ledgers.push(usageLedger(parent.session.sessionManager));
			if (parent.run) trackCompletion(parent.id, active.settled);
		}
		trackCompletion(ROOT, active.settled);
		// Capture reused history before any initialization listeners can bill this run.
		let firstEntry = node.session?.sessionManager.getEntries().length;
		// Reserve the original input ahead of sends made by initialization listeners;
		// the drain below awaits it with the rest of the run's tracked work.
		void submit(node, active, instructions, sent);
		const finish = () => {
			if (node.run === active) node.run = undefined;
			settlement.resolve();
		};
		try {
			changed();
			try {
				// Let receipt/tool-result microtasks finish before any child initialization,
				// including a factory's synchronous pre-await work, can occupy the loop.
				await setImmediate();
				if (!node.session && !node.cancelled && !closing)
					await initialize(node);
				// Earlier cancellation could not stop or clear a session created since.
				if (node.cancelled || closing) abort(node.id);
				if (node.session)
					firstEntry ??= node.session.sessionManager.getEntries().length;
			} catch (error) {
				recordError(node, error);
			} finally {
				initialization.resolve();
			}

			// Only the parent's task reports; a conversation the user continued
			// ends with its last message.
			const taskReportOf = active.userLed ? undefined : reportOf;
			let entries: SessionEntry[];
			let summary: RunSummary & { unreported: boolean };
			for (;;) {
				try {
					// Prompts and deliveries can start further prompts and track more
					// work. Recheck after the await: new completion/input preflight can
					// arrive in the microtask that resolves it. The rest, up to a
					// reminder or finalization, is synchronous.
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
				entries =
					node.session?.sessionManager.getEntries().slice(firstEntry ?? 0) ??
					[];
				summary = summarizeRun(entries, {
					cancelled: node.cancelled,
					error: node.error,
					reportOf: taskReportOf,
				});
				// Idle with nothing left to wait for, yet unreported: remind the task,
				// again only once its tracked work changes (see trackCompletion).
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
			const usage = summarizeOwnUsage(entries);
			// Bill before terminal listeners can restart a conversation. Each run's
			// local delta reaches every captured ancestor exactly once, without a turn
			// or result notification, and regardless of cancellation or delivery failure.
			try {
				for (const { manager, sessionId } of ledgers)
					if (manager.getSessionId() === sessionId)
						manager.appendUsage(
							SUBAGENT_USAGE_KIND,
							node.context.model.provider,
							node.context.model.id,
							usage,
							node.id,
						);
			} finally {
				// Even a ledger write failure must leave a reusable terminal node.
				node.status = summary.status;
				node.error = summary.error;
				// Terminal listeners may immediately start another run; do not attach its
				// input to this summary or let this run's finally erase its bookkeeping.
				finish();
				changed();
			}
			const { status, error, output } = summary;
			return {
				id: node.id,
				status,
				error,
				output,
				usage: summary.usage,
				...(active.leftover && { leftover: true }),
			};
		} finally {
			initialization.resolve();
			finish();
		}
	}

	function stopLeftovers(id: string): string[] {
		const stopped: string[] = [];
		// A child the user continues is theirs, and reports nothing anyway.
		for (const child of nodes.values())
			if (
				child.parentId === id &&
				child.run &&
				!child.run.userLed &&
				!child.cancelled
			) {
				child.run.leftover = true;
				stopped.push(`subagent ${child.id}`);
				abort(child.id);
			}
		for (const completion of completions.get(id) ?? []) {
			const leftover = leftovers.get(completion);
			if (!leftover) continue;
			leftovers.delete(completion);
			try {
				if (leftover.stop()) stopped.push(leftover.label);
			} catch (error) {
				completionErrors.push(error);
			}
		}
		return stopped;
	}

	/** Mirror a published session's events into its node. */
	function attach(node: SubagentNode, session: AgentSession): void {
		node.unsubscribe();
		node.session = session;
		node.unsubscribe = session.subscribe((event) => {
			// Cancellation can precede async prompt validation and loop startup.
			if (node.cancelled && event.type === "agent_start") stopSession(session);
			if (
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end"
			)
				node.liveTools.set(
					event.toolCallId,
					toolSnapshot(event, node.liveTools.get(event.toolCallId)),
				);
			changed();
		});
		changed();
	}

	/** Cleanup failures are reported at shutdown, never thrown at the caller. */
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
			// Cancellation failures are cleanup errors, not an unobserved rejection.
			trackCompletion(ROOT, session.abort());
		} catch (error) {
			completionErrors.push(error);
		}
	}

	function abort(id = ROOT): Map<string, string[]> {
		const discarded = new Map<string, string[]>();
		for (const node of nodes.values()) {
			if (!belongsTo(nodes, node, id) || node.status !== "running") continue;
			node.cancelled = true;
			// Pending prompts observe cancellation and are never submitted.
			const input = Array.from(node.pendingInput, ({ text }) => text);
			node.pendingInput.clear();
			try {
				const queued = node.session?.clearQueue();
				if (queued) input.unshift(...queued.steering, ...queued.followUp);
			} catch (error) {
				completionErrors.push(error);
			}
			if (input.length) discarded.set(node.id, input);
			if (node.session) stopSession(node.session);
			changed();
		}
		return discarded;
	}

	function dispose(): Promise<void> {
		if (closing) return closing;
		// Publish the closing promise before notifying listeners that may request shutdown again.
		closing = Promise.resolve().then(async () => {
			// Every run is tracked under ROOT, and result handlers may register
			// billing/delivery after shutdown began.
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
		stopLeftovers,
		settled,
		send,
		abort,
		dispose,
	};
	return runtime;
}
