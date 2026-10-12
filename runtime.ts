import type {
	AgentMessage,
	AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { createChildSession, type SpawnContext } from "./sessions.ts";

export type { SpawnContext } from "./sessions.ts";

export const ROOT = "root";
export const DEFAULT_MAX_DEPTH = 5;

export interface SubagentDetails {
	id: string;
	parentId: string;
	depth: number;
}

export interface Subagent extends SubagentDetails {
	instructions: string;
	session?: AgentSession;
	context: SpawnContext;
	status: "running" | "done" | "error" | "aborted";
	error?: string;
	revision: number;
	operation?: Promise<void>;
	cancelled: boolean;
	unsubscribe: () => void;
}

export interface Subagents {
	readonly closed: boolean;
	readonly maxDepth: number;
	setMaxDepth(depth: number): void;
	get(id: string): Subagent | undefined;
	/** Preorder traversal of all descendants. */
	tree(): Subagent[];
	subscribe(listener: () => void): () => void;
	spawn(
		parentId: string,
		instructions: string,
		context: SpawnContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SubagentDetails>>;
	/** Steer an active run; otherwise continue the same conversation. */
	send(id: string, instructions: string): Promise<void>;
	/** Cancellation reaches the whole subtree, including user-restarted descendants. */
	abort(id?: string): void;
	dispose(): Promise<void>;
}

interface SubagentsState {
	nodes: Map<string, Subagent>;
	listeners: Set<() => void>;
	childCounts: Map<string, number>;
	closing?: Promise<void>;
	disposed: boolean;
	maxDepth: number;
}

function validateMaxDepth(depth: number): number {
	if (!Number.isSafeInteger(depth) || depth < 0) {
		throw new Error("Subagent max depth must be a non-negative safe integer.");
	}
	return depth;
}

export function parseMaxDepth(value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new Error("Subagent max depth must be a non-negative safe integer.");
	}
	return validateMaxDepth(Number(value));
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

function summarizeRun(
	messages: readonly AgentMessage[],
	cancelled: boolean,
	error?: string,
	extraUsage: readonly Usage[] = [],
) {
	let final: AssistantMessage | undefined;
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const message of messages) {
		if (message.role === "assistant") final = message;
	}
	const usages = [
		...messages.flatMap((message) =>
			(message.role === "assistant" || message.role === "toolResult") &&
			message.usage
				? [message.usage]
				: [],
		),
		...extraUsage,
	];
	for (const used of usages) {
		usage.input += used.input;
		usage.output += used.output;
		usage.cacheRead += used.cacheRead;
		usage.cacheWrite += used.cacheWrite;
		usage.totalTokens += used.totalTokens;
		if (used.reasoning !== undefined)
			usage.reasoning = (usage.reasoning ?? 0) + used.reasoning;
		if (used.cacheWrite1h !== undefined)
			usage.cacheWrite1h = (usage.cacheWrite1h ?? 0) + used.cacheWrite1h;
		for (const key of [
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"total",
		] as const) {
			usage.cost[key] += used.cost[key];
		}
	}

	let status: Subagent["status"];
	if (cancelled || final?.stopReason === "aborted") {
		status = "aborted";
		error = "Subagent was aborted.";
	} else if (error || (final && final.stopReason !== "stop")) {
		status = "error";
		error ??=
			final?.errorMessage ??
			`Subagent ended without a complete response (${final?.stopReason ?? "no response"}).`;
	} else {
		status = "done";
	}
	const output =
		error ||
		final?.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n") ||
		"(no output)";
	return { status, error, output, usage };
}

/** Owns one session's mutable state; all operations are safe to pass as callbacks. */
export function createSubagents(maxDepth = DEFAULT_MAX_DEPTH): Subagents {
	const state: SubagentsState = {
		nodes: new Map(),
		listeners: new Set(),
		childCounts: new Map(),
		disposed: false,
		maxDepth: validateMaxDepth(maxDepth),
	};

	function changed(node?: Subagent): void {
		if (node) node.revision++;
		for (const listener of state.listeners) listener();
	}

	function assertOpen(): void {
		if (state.disposed) throw new Error("Subagents have been shut down.");
	}

	async function spawn(
		parentId: string,
		instructions: string,
		context: SpawnContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SubagentDetails>> {
		assertOpen();
		signal?.throwIfAborted();
		if (!instructions.trim())
			throw new Error("Subagent instructions must not be empty.");
		const parent = state.nodes.get(parentId);
		if (parentId !== ROOT && !parent)
			throw new Error(`Unknown parent: ${parentId}`);
		if (parent?.cancelled) throw new Error(`Parent ${parentId} was aborted.`);
		const depth = (parent?.depth ?? 0) + 1;
		if (depth > state.maxDepth) {
			throw new Error(
				`Subagent depth ${depth} exceeds max depth ${state.maxDepth}.`,
			);
		}

		const count = (state.childCounts.get(parentId) ?? 0) + 1;
		state.childCounts.set(parentId, count);
		const id = parentId === ROOT ? String(count) : `${parentId}.${count}`;
		const node: Subagent = {
			id,
			parentId,
			depth,
			instructions,
			context,
			status: "running",
			revision: 0,
			cancelled: false,
			unsubscribe: () => {},
		};
		state.nodes.set(id, node);
		return run(node, instructions, signal);
	}

	async function send(id: string, instructions: string): Promise<void> {
		assertOpen();
		const node = state.nodes.get(id);
		if (!node) throw new Error(`Unknown subagent: ${id}`);
		if (!instructions.trim()) return;
		if (node.session?.isStreaming) {
			if (node.cancelled) throw new Error(`Subagent ${id} is stopping.`);
			await node.session.prompt(instructions, { streamingBehavior: "steer" });
			changed(node);
			return;
		}
		if (node.operation) {
			await node.operation;
			return send(id, instructions);
		}
		await run(node, instructions);
	}

	async function run(
		node: Subagent,
		instructions: string,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SubagentDetails>> {
		node.cancelled = false;
		node.status = "running";
		node.error = undefined;
		let settle = () => {};
		// Track the whole delegated run before any lifecycle callback can request shutdown.
		node.operation = new Promise<void>((resolve) => {
			settle = resolve;
		});
		try {
			let start = 0;
			const cancel = () => abort(node.id);
			signal?.addEventListener("abort", cancel, { once: true });
			changed(node);
			try {
				if (!node.session && !node.cancelled && !state.disposed) {
					await createChildSession(
						node.context,
						{ runtime: operations, id: node.id },
						(session) => {
							node.unsubscribe();
							node.session = session;
							node.unsubscribe = session.subscribe((event) => {
								// Cancellation can precede async prompt validation and loop startup.
								if (node.cancelled && event.type === "agent_start")
									void session.abort();
								changed(node);
							});
							changed(node);
						},
					);
				}
				if (signal?.aborted || node.cancelled || state.disposed) cancel();
				if (node.session && !node.cancelled) {
					start = node.session.sessionManager.getEntries().length;
					const prompt = node.session.prompt(instructions);
					// Catch cancellation before the session's async input processing activates its loop.
					if (signal?.aborted || node.cancelled || state.disposed) cancel();
					await prompt;
					await node.session.waitForIdle();
				}
			} catch (error) {
				node.error = error instanceof Error ? error.message : String(error);
			} finally {
				signal?.removeEventListener("abort", cancel);
			}

			// Raw entries survive compaction and context edits, so neither final output
			// nor billing disappears when a full pi session repairs its model context.
			const entries =
				node.session?.sessionManager.getEntries().slice(start) ?? [];
			const summary = summarizeRun(
				entries.flatMap((entry) =>
					entry.type === "message" ? [entry.message] : [],
				),
				node.cancelled,
				node.error,
				entries.flatMap((entry) =>
					"usage" in entry && entry.usage ? [entry.usage] : [],
				),
			);
			node.status = summary.status;
			node.error = summary.error;
			const truncated = truncateHead(summary.output);
			changed(node);
			return {
				content: [
					{
						type: "text",
						text:
							truncated.content +
							(truncated.truncated
								? `\n[Full output: /subagents ${node.id}]`
								: ""),
					},
				],
				details: { id: node.id, parentId: node.parentId, depth: node.depth },
				isError: summary.status !== "done",
				usage: summary.usage,
			};
		} finally {
			node.operation = undefined;
			settle();
		}
	}

	function abort(id = ROOT): void {
		for (const node of state.nodes.values()) {
			if (!belongsTo(state.nodes, node, id) || node.status !== "running")
				continue;
			node.cancelled = true;
			node.session?.clearQueue();
			void node.session?.abort();
			changed(node);
		}
	}

	function dispose(): Promise<void> {
		if (state.closing) return state.closing;
		state.disposed = true;
		// Publish the closing promise before notifying listeners that may request shutdown again.
		state.closing = Promise.allSettled(
			[...state.nodes.values()].map((node) => node.operation),
		).then(async () => {
			await Promise.allSettled(
				[...state.nodes.values()].map(async (node) => {
					try {
						await node.session?.extensionRunner.emit({
							type: "session_shutdown",
							reason: "quit",
						});
					} finally {
						node.unsubscribe();
						node.session?.dispose();
					}
				}),
			);
			state.listeners.clear();
			state.nodes.clear();
			state.childCounts.clear();
		});
		abort();
		changed();
		return state.closing;
	}

	const operations: Subagents = {
		get closed() {
			return state.disposed;
		},
		get maxDepth() {
			return state.maxDepth;
		},
		setMaxDepth(depth) {
			state.maxDepth = validateMaxDepth(depth);
			changed();
		},
		get: (id) => state.nodes.get(id),
		tree: () => subagentTree(state.nodes.values()),
		subscribe(listener) {
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
		spawn,
		send,
		abort,
		dispose,
	};
	return operations;
}
