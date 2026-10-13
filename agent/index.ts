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
	appendDelegatedUsage,
	createSubagents,
	ROOT,
	type Subagents,
} from "../runtime/index.ts";
import {
	discardSubagentCompletion,
	subagentCompletionMessage,
} from "./completions.ts";
import {
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_USAGE_TYPE,
	type SubagentCompletionDetails,
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
export function createSubagentRuntime(): Subagents {
	return createSubagents({
		createSession: (context, owner, onCreated) =>
			createChildSession(context, owner, onCreated, subagentsExtension),
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
	parentId: string;
	manager: ExtensionContext["sessionManager"];
	sessionId: string;
	active: boolean;
	abortEpoch: number;
	stopWatchingAbort: () => void;
	accounting: SessionBoundaryDraft[];
	/** Formatting artifacts remain ours until the queued message is persisted. */
	pendingCompletions: Set<SubagentCompletionMessage>;
}

/** Wire Pi's lifecycle and expose the undecorated, machine-facing tool. */
export function createSubagentIntegration(
	pi: ExtensionAPI,
	view?: SubagentView,
) {
	let runtime: Subagents | undefined;
	let binding: SessionBinding | undefined;

	function discardPending(source: SessionBinding): Promise<void> {
		const messages = [...source.pendingCompletions];
		source.pendingCompletions.clear();
		if (!messages.length) return Promise.resolve();
		const cleanup = Promise.all(messages.map(discardSubagentCompletion)).then(
			() => {},
		);
		source.runtime.trackCompletion(source.parentId, cleanup);
		return cleanup;
	}

	function invalidate(): Promise<void> {
		const source = binding;
		if (source) {
			source.active = false;
			source.stopWatchingAbort();
		}
		binding = undefined;
		runtime = undefined;
		return source ? discardPending(source) : Promise.resolve();
	}

	function isCurrent(source: SessionBinding, ctx: ExtensionContext): boolean {
		if (!source.active || binding !== source) return false;
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

	function takeAccounting(ctx: ExtensionContext): SessionBoundaryDraft[] {
		if (!binding || !isCurrent(binding, ctx)) return [];
		return binding.accounting.splice(0);
	}

	// Custom drafts persist metadata, not model context. Pi 1.1.0 cannot attach
	// usage to these drafts; the actual billing entry is appended separately.
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

	pi.on("agent_start", (_event, ctx) => {
		const source = binding;
		if (!source || !isCurrent(source, ctx)) return;
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
		const details = event.message.details as SubagentCompletionDetails;
		for (const message of source.pendingCompletions)
			if (message.details.id === details?.id)
				source.pendingCompletions.delete(message);
	});
	pi.on("agent_settled", async (event, ctx) => {
		const source = binding;
		if (source && isCurrent(source, ctx)) {
			if (event.aborted) source.abortEpoch++;
			source.stopWatchingAbort();
			// Core subtree cancellation clears this headless session's queues.
			if (event.aborted && source.runtime.get(source.parentId)?.cancelled)
				await discardPending(source);
		}
		// Aborted runs may skip the final actionable boundary.
		flushAccounting(ctx);
	});

	const current = (): Subagents => {
		if (!runtime) throw new Error("Subagents are not initialized.");
		return runtime;
	};

	pi.on("session_start", async (_event, ctx) => {
		const owner = sessionOwner(ctx);
		const previous = binding;
		try {
			view?.dispose();
		} finally {
			const cleanup = invalidate();
			if (previous?.parentId === ROOT) await previous.runtime.dispose();
			await cleanup;
		}
		runtime = owner?.runtime ?? createSubagentRuntime();
		binding = {
			runtime,
			parentId: owner?.id ?? ROOT,
			manager: ctx.sessionManager,
			sessionId: ctx.sessionManager.getSessionId(),
			active: true,
			abortEpoch: 0,
			stopWatchingAbort: () => {},
			accounting: [],
			pendingCompletions: new Set(),
		};
		// Delegated sessions stay headless, even under a configured installation.
		if (!owner) view?.bind(runtime, ctx);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		const owner = sessionOwner(ctx);
		const previous = runtime;
		flushAccounting(ctx);
		// Fence deliveries before awaiting cancellation or asynchronous initialization.
		try {
			view?.dispose();
		} finally {
			const cleanup = invalidate();
			if (owner) {
				if (event.reason === "quit") owner.runtime.abort(owner.id);
				else {
					for (const child of owner.runtime.tree())
						if (child.parentId === owner.id) owner.runtime.abort(child.id);
				}
			} else await previous?.dispose();
			await cleanup;
		}
	});

	const tool = defineTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate a task to a subagent. Results arrive on completion.",
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
			const tree = current();
			const source = binding;
			if (!source || !isCurrent(source, ctx))
				throw new Error("Subagent parent session is no longer active.");
			const epoch = source.abortEpoch;
			const context = spawnContext(ctx);
			// After receipt, this job belongs to the runtime, not the parent's turn signal.
			const started = tree.start(source.parentId, instructions, context);
			const canDeliver = () =>
				isCurrent(source, ctx) &&
				!tree.closed &&
				source.abortEpoch === epoch &&
				!signal?.aborted &&
				(source.parentId === ROOT || !tree.get(source.parentId)?.cancelled);
			const completion = started.result
				.then(async (result) => {
					// Billing belongs to the captured session, even if notification is suppressed.
					// Never redirect it through a stale pi/ctx into the replacement session.
					if (source.manager.getSessionId() !== source.sessionId) return;
					// ExtensionContext types its manager read-only, but Pi exposes the public
					// SessionManager instance. appendUsage is the supported SDK billing API;
					// custom-message details/data alone do not contribute to session totals.
					const manager = source.manager as SessionManager;
					appendDelegatedUsage(manager, context.model, result);
					const data = {
						id: result.id,
						status: result.status,
						usage: result.usage,
					};
					const message = canDeliver()
						? await subagentCompletionMessage(result)
						: undefined;
					let queued = false;
					let delivered = false;
					try {
						if (message && canDeliver()) {
							source.pendingCompletions.add(message);
							queued = true;
							source.accounting.push({
								type: "custom",
								customType: SUBAGENT_USAGE_TYPE,
								data,
							});
							const options = {
								deliverAs: "followUp" as const,
								triggerTurn: true,
							};
							if (source.parentId === ROOT) pi.sendMessage(message, options);
							else {
								const parent = tree.get(source.parentId)?.session;
								if (!parent)
									throw new Error("Subagent parent session is unavailable.");
								// Unlike pi.sendMessage (void), the SDK promise observes turn
								// startup failures and keeps headless settlement/billing fenced.
								await parent.sendCustomMessage(message, options);
							}
							delivered = true;
						} else {
							// Cancellation suppresses context delivery, not already-incurred billing.
							if (manager.getSessionId() === source.sessionId)
								manager.appendCustomEntry(SUBAGENT_USAGE_TYPE, data);
						}
					} finally {
						if (
							message &&
							!delivered &&
							(!queued || source.pendingCompletions.delete(message))
						)
							await discardSubagentCompletion(message);
					}
				})
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
			tree.trackCompletion(source.parentId, completion);
			return subagentReceipt(started);
		},
	});

	return { current, tool };
}

/** Headless entrypoint for delegated sessions. */
export default function subagentsExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSubagentIntegration(pi).tool);
}
