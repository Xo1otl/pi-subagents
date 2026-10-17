import {
	type BoundaryResult,
	type BoundaryState,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBoundaryDraft,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	createSubagents,
	ROOT,
	type SessionOwner,
	type SubagentResult,
	type Subagents,
} from "../runtime/index.ts";
import {
	discardSubagentCompletion,
	subagentCompletionMessage,
} from "./completions.ts";
import {
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_USAGE_TYPE,
	type SubagentCompletionMessage,
	subagentReceipt,
} from "./protocol.ts";
import {
	createChildSession,
	disposeChildSession,
	sessionOwner,
	spawnContext,
} from "./sessions.ts";

/** Compose execution with Pi's session lifecycle, without loading presentation. */
export function createSubagentRuntime(
	rootSessionManager?: SessionManager,
): Subagents {
	return createSubagents({
		rootSessionManager,
		createSession: (context, owner, onCreated, onError) =>
			createChildSession(
				context,
				owner,
				onCreated,
				onError,
				subagentsExtension,
			),
		disposeSession: disposeChildSession,
	});
}

/** Root-session presentation. The integration binds it once the session's
 * subagents are installed and releases it before they are torn down.
 */
export interface SubagentView {
	bind(runtime: Subagents, ctx: ExtensionContext): void;
	dispose(): void;
}

interface SessionBinding {
	runtime: Subagents;
	/** Pi's public SessionManager behind the context's read-only view. */
	manager: SessionManager;
	sessionId: string;
	/** Only cancellation aborts a headless session; it fences that session's older children. */
	abortEpoch: number;
	stopWatchingAbort: () => void;
	accounting: SessionBoundaryDraft[];
	/** Formatting artifacts remain ours until the queued message is persisted. */
	pendingCompletions: Set<SubagentCompletionMessage>;
	/** Root completions wait here while it is busy: an interrupt clears pi's queue. */
	held: SubagentCompletionMessage[];
	/** A one-shot root holds results until all of its delegated work has finished. */
	awaitingResults: boolean;
}

/** Wire Pi's lifecycle and return the undecorated, machine-facing tool. */
export function createSubagentIntegration(
	pi: ExtensionAPI,
	view?: SubagentView,
) {
	// Each delegated session loads its own extensions, so the owner is fixed.
	const owner = sessionOwner(pi.events);
	// A root session's children report to ROOT, a delegated session's to its node.
	const parentId = owner?.id ?? ROOT;
	let binding: SessionBinding | undefined;

	function discardPending(source: SessionBinding): Promise<void> {
		const messages = [...source.pendingCompletions];
		source.pendingCompletions.clear();
		source.held.length = 0;
		if (!messages.length) return Promise.resolve();
		const cleanup = Promise.all(messages.map(discardSubagentCompletion)).then(
			() => {},
		);
		source.runtime.trackCompletion(parentId, cleanup);
		return cleanup;
	}

	/** Release presentation, fence deliveries, then stop the session's work:
	 * a root disposes its runtime, a delegated session runs `stopDelegated`.
	 */
	async function teardown(
		stopDelegated: (owner: SessionOwner) => void = () => {},
	): Promise<void> {
		const source = binding;
		try {
			view?.dispose();
		} finally {
			// Fence deliveries before awaiting cancellation or asynchronous initialization.
			source?.stopWatchingAbort();
			binding = undefined;
			const cleanup = source ? discardPending(source) : Promise.resolve();
			if (owner) stopDelegated(owner);
			else await source?.runtime.dispose();
			await cleanup;
		}
	}

	function isCurrent(source: SessionBinding, ctx: ExtensionContext): boolean {
		if (binding !== source) return false;
		try {
			// This guarded getter also detects dispose/replacement without a shutdown event.
			return (
				ctx.sessionManager === source.manager &&
				source.manager.getSessionId() === source.sessionId
			);
		} catch {
			return false;
		}
	}

	/** Persist held root completions in order; only the last may start a turn. */
	function release(source: SessionBinding, triggerTurn: boolean): void {
		const messages = source.held.splice(0);
		messages.forEach((message, index) => {
			const trigger = triggerTurn && index === messages.length - 1;
			pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: trigger });
			// An idle session appends an untriggered message at once, without message_end.
			if (!trigger) source.pendingCompletions.delete(message);
		});
	}

	function releaseIfIdle(source: SessionBinding, ctx: ExtensionContext): void {
		if (isCurrent(source, ctx) && ctx.isIdle() && !source.awaitingResults)
			release(source, true);
	}

	function takeAccounting(ctx: ExtensionContext): SessionBoundaryDraft[] {
		if (!binding || !isCurrent(binding, ctx)) return [];
		return binding.accounting.splice(0);
	}

	// Custom drafts persist metadata, not model context. Boundary drafts cannot
	// carry usage; the actual billing entry is appended separately.
	function appendAccounting(
		event: BoundaryState,
		ctx: ExtensionContext,
	): BoundaryResult | undefined {
		const drafts = takeAccounting(ctx);
		if (drafts.length) return { entries: [...event.entries, ...drafts] };
	}
	pi.on("turn_end", appendAccounting);
	pi.on("agent_before_settle", appendAccounting);

	function flushAccounting(ctx: ExtensionContext): void {
		for (const draft of takeAccounting(ctx)) {
			if (draft.type === "custom") pi.appendEntry(draft.customType, draft.data);
		}
	}

	/** Add one result to its parent's context, or only record it when fenced.
	 * Run billing is already persisted, independently of this notification.
	 */
	async function deliver(
		source: SessionBinding,
		ctx: ExtensionContext,
		result: SubagentResult,
		canDeliver: () => boolean,
	): Promise<void> {
		const data = { id: result.id, status: result.status, usage: result.usage };
		const message = canDeliver()
			? await subagentCompletionMessage(result)
			: undefined;
		if (!message || !canDeliver()) {
			try {
				// Cancellation suppresses context delivery, not already-incurred billing.
				if (source.manager.getSessionId() === source.sessionId)
					source.manager.appendCustomEntry(SUBAGENT_USAGE_TYPE, data);
			} finally {
				if (message) await discardSubagentCompletion(message);
			}
			return;
		}
		source.pendingCompletions.add(message);
		source.accounting.push({
			type: "custom",
			customType: SUBAGENT_USAGE_TYPE,
			data,
		});
		try {
			if (!owner) {
				source.held.push(message);
				releaseIfIdle(source, ctx);
				return;
			}
			const parent = source.runtime.get(owner.id)?.session;
			if (!parent) throw new Error("Subagent parent session is unavailable.");
			// Unlike pi.sendMessage (void), the SDK promise observes turn
			// startup failures and keeps headless settlement/billing fenced.
			await parent.sendCustomMessage(message, {
				deliverAs: "followUp",
				triggerTurn: true,
			});
		} catch (error) {
			// Unless it was already persisted or discarded with its binding.
			if (source.pendingCompletions.delete(message))
				await discardSubagentCompletion(message);
			throw error;
		}
	}

	pi.on("agent_start", (_event, ctx) => {
		const source = binding;
		// Interrupting the root stops its turn, never the delivery of results.
		if (!owner || !source || !isCurrent(source, ctx)) return;
		source.stopWatchingAbort();
		const signal = ctx.signal;
		const fence = () => {
			source.abortEpoch++;
		};
		// Fence immediately, not after potentially asynchronous agent_end handlers.
		signal?.addEventListener("abort", fence, { once: true });
		if (signal?.aborted) fence();
		source.stopWatchingAbort = () =>
			signal?.removeEventListener("abort", fence);
	});
	pi.on("message_end", (event, ctx) => {
		const source = binding;
		if (
			!source ||
			!isCurrent(source, ctx) ||
			event.message.role !== "custom" ||
			event.message.customType !== SUBAGENT_RESULT_TYPE
		)
			return;
		// A continued agent reuses its ID, so match this exact completion.
		for (const message of source.pendingCompletions)
			if (message.details === event.message.details)
				source.pendingCompletions.delete(message);
	});
	pi.on("agent_settled", async (event, ctx) => {
		const source = binding;
		if (source && isCurrent(source, ctx)) {
			source.stopWatchingAbort();
			if (owner) {
				if (event.aborted) source.abortEpoch++;
				// Core subtree cancellation clears this headless session's queues.
				if (event.aborted && source.runtime.get(owner.id)?.cancelled)
					await discardPending(source);
			} else {
				if (ctx.mode === "print" || ctx.mode === "json") {
					// One-shot modes exit after settling, which would cancel delegated work.
					source.awaitingResults = true;
					try {
						await source.runtime.settled(ROOT);
					} finally {
						source.awaitingResults = false;
					}
				}
				// After an interrupt, keep the results without restarting the turn.
				if (isCurrent(source, ctx)) release(source, !event.aborted);
			}
		}
		// Aborted runs may skip the final actionable boundary.
		flushAccounting(ctx);
	});
	// Compaction and branch summaries occupy an idle root without a run to settle.
	const releaseAfterIdleWork = (_event: unknown, ctx: ExtensionContext) => {
		const source = binding;
		if (source?.held.length) setImmediate(() => releaseIfIdle(source, ctx));
	};
	pi.on("session_compact", releaseAfterIdleWork);
	pi.on("session_compact_failed", releaseAfterIdleWork);
	pi.on("session_tree", releaseAfterIdleWork);

	pi.on("session_start", async (_event, ctx) => {
		await teardown();
		// ExtensionContext exposes a read-only view of Pi's public SessionManager.
		// Capture the actual ledger once; run billing must survive binding teardown.
		const manager = ctx.sessionManager as SessionManager;
		const runtime = owner?.runtime ?? createSubagentRuntime(manager);
		binding = {
			runtime,
			manager,
			sessionId: manager.getSessionId(),
			abortEpoch: 0,
			stopWatchingAbort: () => {},
			accounting: [],
			pendingCompletions: new Set(),
			held: [],
			awaitingResults: false,
		};
		// Delegated sessions stay headless, even under a configured installation.
		if (!owner) view?.bind(runtime, ctx);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		flushAccounting(ctx);
		await teardown(({ runtime, id }) => {
			// Quitting ends this subagent's run; replacing its conversation only
			// cancels its children.
			if (event.reason === "quit") runtime.abort(id);
			else
				for (const child of runtime.tree())
					if (child.parentId === id) runtime.abort(child.id);
		});
	});

	return defineTool({
		name: "subagent",
		label: "Subagent",
		description: "Replies to the parent when done.",
		parameters: Type.Object({
			instructions: Type.String({ minLength: 1 }),
		}),
		outputSchema: Type.Object({
			id: Type.String(),
			status: Type.Literal("running"),
		}),
		executionMode: "parallel",
		async execute(_id, { instructions }, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const source = binding;
			if (!source || !isCurrent(source, ctx))
				throw new Error("Subagent parent session is no longer active.");
			const tree = source.runtime;
			const epoch = source.abortEpoch;
			const context = spawnContext(ctx, owner);
			// After receipt, this job belongs to the runtime, not the parent's turn signal.
			const started = tree.start(parentId, instructions, context);
			const canDeliver = () =>
				isCurrent(source, ctx) &&
				!tree.closed &&
				(!owner ||
					(source.abortEpoch === epoch &&
						!signal?.aborted &&
						!tree.get(owner.id)?.cancelled));
			const completion = started.result
				.then((result) => deliver(source, ctx, result, canDeliver))
				.catch((error: unknown) => {
					if (canDeliver())
						ctx.ui.notify(
							`Subagent ${started.id} completion delivery failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					// Headless UI is a no-op. Keep the rejection for runtime settlement
					// (or shutdown reporting at root) instead of silently losing it.
					throw error;
				});
			tree.trackCompletion(parentId, completion);
			return subagentReceipt(started);
		},
	});
}

/** Headless entrypoint for delegated sessions. */
export default function subagentsExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSubagentIntegration(pi));
}
