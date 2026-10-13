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
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	appendDelegatedUsage,
	type RunSummary,
	summarizeOwnUsage,
	summarizeRun,
} from "./summary.ts";

export { appendDelegatedUsage, SUBAGENT_USAGE_KIND } from "./summary.ts";

export interface SpawnContext
	extends Pick<CreateAgentSessionOptions, "agentDir" | "modelRuntime"> {
	cwd: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	projectTrusted: boolean;
}

export interface SessionOwner {
	runtime: Subagents;
	id: string;
}

/** onCreated transfers cleanup ownership, even if initialization later rejects.
 * onError receives the session's extension errors, e.g. through bindExtensions.
 */
export type ChildSessionFactory = (
	context: SpawnContext,
	owner: SessionOwner,
	onCreated: (session: AgentSession) => void,
	onError: (error: ExtensionError) => void,
) => Promise<AgentSession>;

export interface SubagentsOptions {
	createSession: ChildSessionFactory;
	disposeSession: (session: AgentSession) => Promise<void>;
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

export interface SubagentStart {
	id: string;
	result: Promise<SubagentResult>;
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
		signal?: AbortSignal,
	): SubagentStart;
	/** Include asynchronous result delivery in a headless parent's settlement. */
	trackCompletion(parentId: string, completion: Promise<void>): void;
	/** Resolves once a parent's tracked delivery work, including late additions, drains. */
	settled(parentId: string): Promise<void>;
	/** Steer an active run; otherwise continue the same conversation. */
	send(id: string, instructions: string): Promise<void>;
	/** Cancellation reaches the whole subtree, including user-restarted descendants.
	 * Returns the queued input it discarded, by agent, so callers can restore it.
	 */
	abort(id?: string): ReadonlyMap<string, readonly string[]>;
	dispose(): Promise<void>;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

interface ActiveRun {
	/** Serialize input preflight, not entire prompts or delegated runs. */
	preflight: Promise<void>;
	/** Settles once the run, including descendant delivery, finishes. */
	settled: Promise<void>;
}

interface SubagentNode extends Writable<Subagent> {
	liveTools: Map<string, SubagentToolExecution>;
	/** Input awaiting the session's preflight; identity distinguishes equal texts. */
	pendingInput: Set<{ readonly text: string }>;
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

interface SubagentsState {
	nodes: Map<string, SubagentNode>;
	completions: Map<string, Set<Promise<void>>>;
	completionErrors: unknown[];
	listeners: Set<() => void>;
	childCounts: Map<string, number>;
	closing?: Promise<void>;
	disposed: boolean;
}

function subagentTree(nodes: Iterable<Subagent>): Subagent[] {
	const children = new Map<string, Subagent[]>();
	for (const node of nodes) {
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node);
		children.set(node.parentId, siblings);
	}
	const stack = [...(children.get(ROOT) ?? [])].reverse();
	const result: Subagent[] = [];
	while (stack.length) {
		const node = stack.pop();
		if (!node) break;
		result.push(node);
		stack.push(...[...(children.get(node.id) ?? [])].reverse());
	}
	return result;
}

function queuedInput(node: SubagentNode): string[] {
	return [
		...(node.session?.getSteeringMessages() ?? []),
		...(node.session?.getFollowUpMessages() ?? []),
		...[...node.pendingInput].map((input) => input.text),
	];
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
	node.error ??= error instanceof Error ? error.message : String(error);
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
	disposeSession,
	rootSessionManager,
}: SubagentsOptions): Subagents {
	const rootLedger = rootSessionManager && usageLedger(rootSessionManager);
	const state: SubagentsState = {
		nodes: new Map(),
		completions: new Map(),
		completionErrors: [],
		listeners: new Set(),
		childCounts: new Map(),
		disposed: false,
	};

	function changed(): void {
		for (const listener of state.listeners) listener();
	}

	function assertOpen(): void {
		if (state.disposed) throw new Error("Subagents have been shut down.");
	}

	function start(
		parentId: string,
		instructions: string,
		context: SpawnContext,
		signal?: AbortSignal,
	): SubagentStart {
		assertOpen();
		signal?.throwIfAborted();
		if (!instructions.trim())
			throw new Error("Subagent instructions must not be empty.");
		const parent = state.nodes.get(parentId);
		if (parentId !== ROOT && !parent)
			throw new Error(`Unknown parent: ${parentId}`);
		if (parent?.cancelled) throw new Error(`Parent ${parentId} was aborted.`);
		const depth = (parent?.depth ?? 0) + 1;

		const count = (state.childCounts.get(parentId) ?? 0) + 1;
		state.childCounts.set(parentId, count);
		const id = parentId === ROOT ? String(count) : `${parentId}.${count}`;
		const node: SubagentNode = {
			id,
			parentId,
			depth,
			instructions,
			context,
			status: "running",
			cancelled: false,
			unsubscribe: () => {},
			liveTools: new Map(),
			pendingInput: new Set(),
			get queuedInput() {
				return queuedInput(node);
			},
		};
		state.nodes.set(id, node);
		const result = run(node, instructions, signal);
		// Observe even detached results; the original promise remains usable by callers.
		void result.catch(() => {});
		return { id, result };
	}

	function trackCompletion(parentId: string, completion: Promise<void>): void {
		const pending = state.completions.get(parentId) ?? new Set();
		state.completions.set(parentId, pending);
		pending.add(completion);
		const remove = () => {
			pending.delete(completion);
			if (!pending.size && state.completions.get(parentId) === pending)
				state.completions.delete(parentId);
		};
		// Observe detached work, but retain failures even if they settle before drainage.
		void completion.then(remove, (error: unknown) => {
			const node = state.nodes.get(parentId);
			if (node?.run) recordError(node, error);
			else state.completionErrors.push(error);
			remove();
		});
	}

	function submit(
		node: SubagentNode,
		active: ActiveRun,
		instructions: string,
		sent: boolean,
	): Promise<void> {
		const previous = active.preflight;
		let resolvePreflight = () => {};
		active.preflight = new Promise<void>((resolve) => {
			resolvePreflight = resolve;
		});
		// Sent input is queued until the session queues, starts or handles it.
		const input = { text: instructions };
		if (sent) node.pendingInput.add(input);
		const accepted = (disposition?: string) => {
			const withdrawn = sent && !node.pendingInput.delete(input);
			// Stopping already handed this input back; it must not reach the agent too.
			if (withdrawn && disposition === "queued") node.session?.clearQueue();
			resolvePreflight();
		};
		const prompt = previous.then(async () => {
			try {
				if (!node.session || node.cancelled || state.disposed) return;
				await node.session.prompt(instructions, {
					streamingBehavior: "steer",
					preflightResult: accepted,
				});
			} finally {
				accepted();
			}
		});
		// Input hooks can outlive the current session prompt and even start a new one.
		// Register before invoking them so cancellation/disposal and billing cover both.
		trackCompletion(node.id, prompt);
		return prompt;
	}

	async function settled(parentId: string): Promise<void> {
		for (
			let pending = state.completions.get(parentId);
			pending?.size;
			pending = state.completions.get(parentId)
		)
			await Promise.allSettled([...pending]);
	}

	async function drain(node: SubagentNode): Promise<void> {
		const pending = state.completions.get(node.id);
		if (pending?.size) await Promise.allSettled([...pending]);
		// Completion delivery may have started another prompt after the first settled.
		await node.session?.waitForIdle();
	}

	async function send(id: string, instructions: string): Promise<void> {
		assertOpen();
		const node = state.nodes.get(id);
		if (!node) throw new Error(`Unknown subagent: ${id}`);
		if (!instructions.trim()) return;
		if (node.run) {
			if (node.cancelled) throw new Error(`Subagent ${id} is stopping.`);
			const prompt = submit(node, node.run, instructions, true);
			changed();
			await prompt;
			changed();
		} else await run(node, instructions, undefined, true);
	}

	async function run(
		node: SubagentNode,
		instructions: string,
		signal?: AbortSignal,
		sent = false,
	): Promise<SubagentResult> {
		node.cancelled = false;
		node.status = "running";
		node.error = undefined;
		node.liveTools.clear();
		let initialized = () => {};
		let settle = () => {};
		// Track the whole delegated run before any lifecycle callback can request shutdown.
		const active: ActiveRun = {
			preflight: new Promise<void>((resolve) => {
				initialized = resolve;
			}),
			settled: new Promise<void>((resolve) => {
				settle = resolve;
			}),
		};
		node.run = active;
		const ledgers: UsageLedger[] = rootLedger ? [rootLedger] : [];
		// Resumed descendants belong to any active ancestors too, even when their
		// immediate parent has already completed. Idle ancestors receive billing only.
		for (
			let parent = state.nodes.get(node.parentId);
			parent;
			parent = state.nodes.get(parent.parentId)
		) {
			if (parent.session)
				ledgers.push(usageLedger(parent.session.sessionManager));
			if (parent.run) trackCompletion(parent.id, active.settled);
		}
		trackCompletion(ROOT, active.settled);
		// Capture reused history before any initialization listeners can bill this run.
		let start = node.session?.sessionManager.getEntries().length;
		// Reserve the original input ahead of sends made by initialization listeners.
		const prompt = submit(node, active, instructions, sent);
		const cancel = () => abort(node.id);
		const finish = () => {
			signal?.removeEventListener("abort", cancel);
			if (node.run === active) node.run = undefined;
			settle();
		};
		try {
			let creatingSession = false;
			signal?.addEventListener("abort", cancel, { once: true });
			changed();
			try {
				// Let receipt/tool-result microtasks finish before any child initialization,
				// including a factory's synchronous pre-await work, can occupy the loop.
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (!node.session && !node.cancelled && !state.disposed) {
					creatingSession = true;
					await createSession(
						node.context,
						{ runtime: operations, id: node.id },
						(session) => attach(node, session),
						(error) => {
							if (node.run) node.error ??= error.error;
							else state.completionErrors.push(new Error(error.error));
							changed();
						},
					);
					creatingSession = false;
				}
				if (signal?.aborted || node.cancelled || state.disposed) cancel();
				if (node.session)
					start ??= node.session.sessionManager.getEntries().length;
			} catch (error) {
				recordError(node, error);
				if (creatingSession && node.session) {
					// A published session whose binding failed is not reusable.
					const session = node.session;
					node.session = undefined;
					await detach(node, session);
				}
			} finally {
				initialized();
			}

			try {
				await prompt;
			} catch (error) {
				recordError(node, error);
			}
			for (;;) {
				try {
					await drain(node);
				} catch (error) {
					recordError(node, error);
					break;
				}
				// Recheck after the await: new completion/input preflight can arrive in
				// the microtask that resolves drain. Finalization below is synchronous.
				if (
					!state.completions.get(node.id)?.size &&
					node.session?.isIdle !== false
				)
					break;
			}

			const entries =
				node.session?.sessionManager.getEntries().slice(start ?? 0) ?? [];
			const summary = summarizeRun(entries, node.cancelled, node.error);
			const usage = summarizeOwnUsage(entries);
			// Bill before terminal listeners can restart a conversation. Each run's
			// local delta reaches every captured ancestor exactly once, without a turn
			// or result notification, and regardless of cancellation or delivery failure.
			try {
				for (const { manager, sessionId } of ledgers)
					if (manager.getSessionId() === sessionId)
						appendDelegatedUsage(manager, node.context.model, {
							id: node.id,
							usage,
						});
			} finally {
				// Even a ledger write failure must leave a reusable terminal node.
				node.status = summary.status;
				node.error = summary.error;
				// Terminal listeners may immediately start another run; do not attach its
				// input to this summary or let this run's finally erase its bookkeeping.
				finish();
				changed();
			}
			return {
				id: node.id,
				...summary,
			};
		} finally {
			initialized();
			finish();
		}
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
			state.completionErrors.push(error);
		} finally {
			try {
				node.unsubscribe();
			} catch (error) {
				state.completionErrors.push(error);
			}
			node.unsubscribe = () => {};
		}
	}

	function stopSession(session: AgentSession): void {
		try {
			// Cancellation failures are cleanup errors, not an unobserved rejection.
			trackCompletion(ROOT, session.abort());
		} catch (error) {
			state.completionErrors.push(error);
		}
	}

	function abort(id = ROOT): Map<string, string[]> {
		const discarded = new Map<string, string[]>();
		for (const node of state.nodes.values()) {
			if (!belongsTo(state.nodes, node, id) || node.status !== "running")
				continue;
			node.cancelled = true;
			// Pending prompts observe cancellation and are never submitted.
			const input = [...node.pendingInput].map((entry) => entry.text);
			node.pendingInput.clear();
			try {
				const queued = node.session?.clearQueue();
				if (queued) input.unshift(...queued.steering, ...queued.followUp);
			} catch (error) {
				state.completionErrors.push(error);
			}
			if (input.length) discarded.set(node.id, input);
			if (node.session) stopSession(node.session);
			changed();
		}
		return discarded;
	}

	function dispose(): Promise<void> {
		if (state.closing) return state.closing;
		state.disposed = true;
		// Publish the closing promise before notifying listeners that may request shutdown again.
		state.closing = Promise.allSettled(
			[...state.nodes.values()].map((node) => node.run?.settled),
		).then(async () => {
			// Result handlers may register billing/delivery after shutdown began.
			while (state.completions.size) {
				await Promise.allSettled(
					[...state.completions.values()].flatMap((pending) => [...pending]),
				);
			}
			await Promise.all(
				[...state.nodes.values()].map((node) => detach(node, node.session)),
			);
			const errors = [...state.completionErrors];
			state.listeners.clear();
			state.nodes.clear();
			state.childCounts.clear();
			state.completions.clear();
			state.completionErrors.length = 0;
			if (errors.length)
				throw new AggregateError(errors, "Subagent cleanup failed.");
		});
		abort();
		changed();
		return state.closing;
	}

	const operations: Subagents = {
		get closed() {
			return state.disposed;
		},
		get: (id) => state.nodes.get(id),
		tree: () => subagentTree(state.nodes.values()),
		subscribe(listener) {
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
		start,
		trackCompletion,
		settled,
		send,
		abort,
		dispose,
	};
	return operations;
}
