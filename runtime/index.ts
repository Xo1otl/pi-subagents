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

export interface SubagentsOptions {
	/** onCreated transfers cleanup ownership, even if initialization later rejects.
	 * onError receives the session's extension errors, e.g. through bindExtensions.
	 */
	createSession: (
		context: SpawnContext,
		owner: SessionOwner,
		onCreated: (session: AgentSession) => void,
		onError: (error: ExtensionError) => void,
	) => Promise<AgentSession>;
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
	): SubagentStart;
	/** Include asynchronous work, such as result delivery, in a parent's settlement. */
	trackCompletion(parentId: string, completion: Promise<void>): void;
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
	const children = new Map<string, Subagent[]>();
	for (const node of nodes) {
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node);
		children.set(node.parentId, siblings);
	}
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
	const nodes = new Map<string, SubagentNode>();
	/** Outstanding work by the parent whose settlement includes it. */
	const completions = new Map<string, Set<Promise<void>>>();
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
	): SubagentStart {
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
			get queuedInput() {
				return [
					...(node.session?.getSteeringMessages() ?? []),
					...(node.session?.getFollowUpMessages() ?? []),
					...[...node.pendingInput].map((input) => input.text),
				];
			},
		};
		nodes.set(id, node);
		const result = run(node, instructions);
		// Observe even detached results; the original promise remains usable by callers.
		void result.catch(() => {});
		return { id, result };
	}

	function trackCompletion(parentId: string, completion: Promise<void>): void {
		const pending = completions.get(parentId) ?? new Set();
		completions.set(parentId, pending);
		pending.add(completion);
		const remove = () => {
			pending.delete(completion);
			if (!pending.size && completions.get(parentId) === pending)
				completions.delete(parentId);
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
			await Promise.allSettled([...pending]);
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
			settle();
		};
		try {
			changed();
			try {
				// Let receipt/tool-result microtasks finish before any child initialization,
				// including a factory's synchronous pre-await work, can occupy the loop.
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (!node.session && !node.cancelled && !closing)
					await initialize(node);
				// Earlier cancellation could not stop or clear a session created since.
				if (node.cancelled || closing) abort(node.id);
				if (node.session)
					firstEntry ??= node.session.sessionManager.getEntries().length;
			} catch (error) {
				recordError(node, error);
			} finally {
				initialized();
			}

			try {
				// Prompts and deliveries can start further prompts and track more work.
				// Recheck after the await: new completion/input preflight can arrive in
				// the microtask that resolves it. Finalization below is synchronous.
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

			const entries =
				node.session?.sessionManager.getEntries().slice(firstEntry ?? 0) ?? [];
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
			const input = [...node.pendingInput].map((entry) => entry.text);
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
				[...nodes.values()].map((node) => detach(node, node.session)),
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
		settled,
		send,
		abort,
		dispose,
	};
	return runtime;
}
