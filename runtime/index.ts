import type {
	AgentToolResult,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { type RunSummary, summarizeRun } from "./summary.ts";

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

/** onCreated transfers cleanup ownership, even if initialization later rejects. */
export type ChildSessionFactory = (
	context: SpawnContext,
	owner: SessionOwner,
	onCreated: (session: AgentSession) => void,
) => Promise<AgentSession>;

export interface SubagentsOptions {
	createSession: ChildSessionFactory;
	disposeSession: (session: AgentSession) => Promise<void>;
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
	/** Steer an active run; otherwise continue the same conversation. */
	send(id: string, instructions: string): Promise<void>;
	/** Cancellation reaches the whole subtree, including user-restarted descendants. */
	abort(id?: string): void;
	dispose(): Promise<void>;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

interface SubagentNode extends Writable<Subagent> {
	liveTools: Map<string, SubagentToolExecution>;
	/** Settles once the current run, including descendant delivery, finishes. */
	operation?: Promise<void>;
	unsubscribe: () => void;
}

interface ActiveRun {
	/** Serialize input preflight, not entire prompts or delegated runs. */
	preflight: Promise<void>;
}

interface SubagentsState {
	nodes: Map<string, SubagentNode>;
	runs: Map<string, ActiveRun>;
	completions: Map<string, Set<Promise<void>>>;
	completionErrors: unknown[];
	delegatedUsage: Map<string, Map<string, Usage>>;
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

/** Owns one session's mutable state; all operations are safe to pass as callbacks. */
export function createSubagents({
	createSession,
	disposeSession,
}: SubagentsOptions): Subagents {
	const state: SubagentsState = {
		nodes: new Map(),
		runs: new Map(),
		completions: new Map(),
		completionErrors: [],
		delegatedUsage: new Map(),
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
		};
		state.nodes.set(id, node);
		const parentUsage = state.delegatedUsage.get(parentId);
		const result = run(node, instructions, signal);
		// Observe even detached results; the original promise remains usable by callers.
		void result.catch(() => {});
		if (parentUsage) {
			trackCompletion(
				parentId,
				result.then((completed) => {
					parentUsage.set(id, completed.usage);
				}),
			);
		}
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
			if (node?.operation)
				node.error ??= error instanceof Error ? error.message : String(error);
			else state.completionErrors.push(error);
			remove();
		});
	}

	function submit(
		node: SubagentNode,
		active: ActiveRun,
		instructions: string,
	): Promise<void> {
		const previous = active.preflight;
		let accepted = () => {};
		active.preflight = new Promise<void>((resolve) => {
			accepted = resolve;
		});
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
		const active = state.runs.get(id);
		if (active) {
			if (node.cancelled) throw new Error(`Subagent ${id} is stopping.`);
			await submit(node, active, instructions);
			changed();
		} else await run(node, instructions);
	}

	async function run(
		node: SubagentNode,
		instructions: string,
		signal?: AbortSignal,
	): Promise<SubagentResult> {
		node.cancelled = false;
		node.status = "running";
		node.error = undefined;
		node.liveTools.clear();
		const delegatedUsage = new Map<string, Usage>();
		state.delegatedUsage.set(node.id, delegatedUsage);
		let settle = () => {};
		// Track the whole delegated run before any lifecycle callback can request shutdown.
		node.operation = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const operation = node.operation;
		let initialized = () => {};
		const active: ActiveRun = {
			preflight: new Promise<void>((resolve) => {
				initialized = resolve;
			}),
		};
		state.runs.set(node.id, active);
		// Reserve the original input ahead of sends made by initialization listeners.
		const prompt = submit(node, active, instructions);
		const cancel = () => abort(node.id);
		const finish = () => {
			signal?.removeEventListener("abort", cancel);
			if (state.runs.get(node.id) === active) state.runs.delete(node.id);
			if (node.operation === operation) node.operation = undefined;
			if (state.delegatedUsage.get(node.id) === delegatedUsage)
				state.delegatedUsage.delete(node.id);
			settle();
		};
		try {
			let start = 0;
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
						(session) => {
							node.unsubscribe();
							node.session = session;
							const unsubscribeErrors = session.extensionRunner?.onError(
								(error) => {
									if (node.operation) node.error ??= error.error;
									else state.completionErrors.push(new Error(error.error));
									changed();
								},
							);
							const unsubscribe = session.subscribe((event) => {
								// Cancellation can precede async prompt validation and loop startup.
								if (node.cancelled && event.type === "agent_start")
									stopSession(session);
								if (
									event.type === "tool_execution_start" ||
									event.type === "tool_execution_update" ||
									event.type === "tool_execution_end"
								) {
									const previous = node.liveTools.get(event.toolCallId);
									node.liveTools.set(event.toolCallId, {
										toolCallId: event.toolCallId,
										toolName: event.toolName,
										args:
											event.type === "tool_execution_end"
												? previous?.args
												: event.args,
										parentToolCallId:
											event.parentToolCallId ?? previous?.parentToolCallId,
										result:
											event.type === "tool_execution_end"
												? event.result
												: event.type === "tool_execution_update"
													? event.partialResult
													: undefined,
										status:
											event.type === "tool_execution_end"
												? event.isError
													? "error"
													: "done"
												: "running",
									});
								}
								changed();
							});
							node.unsubscribe = () => {
								unsubscribe();
								unsubscribeErrors?.();
							};
							changed();
						},
					);
					creatingSession = false;
				}
				if (signal?.aborted || node.cancelled || state.disposed) cancel();
				if (node.session)
					start = node.session.sessionManager.getEntries().length;
			} catch (error) {
				node.error ??= error instanceof Error ? error.message : String(error);
				if (creatingSession && node.session) {
					// A published session whose binding failed is not reusable.
					const session = node.session;
					node.session = undefined;
					try {
						await disposeSession(session);
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
			} finally {
				initialized();
			}

			try {
				await prompt;
			} catch (error) {
				node.error ??= error instanceof Error ? error.message : String(error);
			}
			for (;;) {
				try {
					await drain(node);
				} catch (error) {
					node.error ??= error instanceof Error ? error.message : String(error);
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

			const summary = summarizeRun(
				node.session?.sessionManager.getEntries().slice(start) ?? [],
				node.cancelled,
				node.error,
				delegatedUsage,
			);
			node.status = summary.status;
			node.error = summary.error;
			// Terminal listeners may immediately start another run; do not attach its
			// input to this summary or let this run's finally erase its bookkeeping.
			finish();
			changed();
			return {
				id: node.id,
				...summary,
			};
		} finally {
			initialized();
			finish();
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

	function abort(id = ROOT): void {
		for (const node of state.nodes.values()) {
			if (!belongsTo(state.nodes, node, id) || node.status !== "running")
				continue;
			node.cancelled = true;
			try {
				node.session?.clearQueue();
			} catch (error) {
				state.completionErrors.push(error);
			}
			if (node.session) stopSession(node.session);
			changed();
		}
	}

	function dispose(): Promise<void> {
		if (state.closing) return state.closing;
		state.disposed = true;
		// Publish the closing promise before notifying listeners that may request shutdown again.
		state.closing = Promise.allSettled(
			[...state.nodes.values()].map((node) => node.operation),
		).then(async () => {
			// Result handlers may register billing/delivery after shutdown began.
			while (state.completions.size) {
				await Promise.allSettled(
					[...state.completions.values()].flatMap((pending) => [...pending]),
				);
			}
			await Promise.all(
				[...state.nodes.values()].map(async (node) => {
					try {
						if (node.session) await disposeSession(node.session);
					} catch (error) {
						state.completionErrors.push(error);
					} finally {
						try {
							node.unsubscribe();
						} catch (error) {
							state.completionErrors.push(error);
						}
					}
				}),
			);
			const errors = [...state.completionErrors];
			state.listeners.clear();
			state.nodes.clear();
			state.runs.clear();
			state.childCounts.clear();
			state.completions.clear();
			state.completionErrors.length = 0;
			state.delegatedUsage.clear();
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
		send,
		abort,
		dispose,
	};
	return operations;
}
