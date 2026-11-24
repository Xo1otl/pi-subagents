import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type BoundaryResult,
	type BoundaryState,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionManager,
	type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorMessage } from "../runtime/errors.ts";
import {
	createSubagents,
	ROOT,
	type SubagentResult,
	type Subagents,
} from "../runtime/index.ts";
import { type CommandHost, trackCommands } from "./commands.ts";
import {
	discardSubagentCompletion,
	subagentCompletionMessage,
} from "./completions.ts";
import { servesSession } from "./context.ts";
import {
	configuredMaxDepth,
	registerDepthCommand,
	registerSpawnTool,
} from "./depth.ts";
import {
	type CommandMessage,
	reportOf,
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_USAGE_TYPE,
	type SubagentCompletionMessage,
	subagentReceipt,
} from "./protocol.ts";
import { registerReporting } from "./report.ts";
import {
	createChildSession,
	disposeChildSession,
	remindChildSession,
	sessionOwner,
	spawnContext,
} from "./sessions.ts";

const EFFORTS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

export function createSubagentRuntime({
	rootSessionManager,
	maxDepth,
}: {
	rootSessionManager?: SessionManager;
	maxDepth?: number;
} = {}): Subagents {
	return createSubagents({
		rootSessionManager,
		maxDepth,
		createSession: (request) => createChildSession(request, headlessExtension),
		remindSession: remindChildSession,
		disposeSession: disposeChildSession,
		reportOf,
	});
}

export interface SubagentView {
	bind(runtime: Subagents, ctx: ExtensionContext): void;
	dispose(): void;
}

type Notice = SubagentCompletionMessage | CommandMessage;

type CompletionRecord = Pick<SubagentResult, "id" | "status" | "usage">;

interface SessionBinding {
	runtime: Subagents;
	manager: SessionManager;
	sessionId: string;
	abortEpoch: number;
	stopWatchingAbort?: () => void;
	accounting: CompletionRecord[];
	pendingCompletions: Set<SubagentCompletionMessage>;
	held: Notice[];
}

export function createSubagentIntegration(
	pi: ExtensionAPI,
	view?: SubagentView,
) {
	const owner = sessionOwner(pi.events);
	const parentId = owner?.id ?? ROOT;
	let binding: SessionBinding | undefined;
	if (owner) registerReporting(pi, owner);
	else {
		trackCommands(pi, rootCommands());
		registerDepthCommand(pi, (ctx) => current(ctx)?.runtime);
	}

	function rootCommands(): CommandHost {
		return {
			ownsJobs: false,
			track(work, ctx) {
				const source = current(ctx);
				if (!source) {
					void work.catch(() => {});
					return;
				}
				const reported = work.catch((error: unknown) => {
					ctx.ui.notify(
						`Background command tracking failed: ${errorMessage(error)}`,
						"error",
					);
					throw error;
				});
				source.runtime.trackCompletion(ROOT, reported);
			},
			listener(ctx) {
				const source = current(ctx);
				if (!source) return undefined;
				return (message) => {
					if (isCurrent(source, ctx)) hold(source, ctx, message);
				};
			},
		};
	}

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

	async function teardown(
		shutdown?: SessionShutdownEvent["reason"],
	): Promise<void> {
		const source = binding;
		try {
			view?.dispose();
		} finally {
			source?.stopWatchingAbort?.();
			binding = undefined;
			const cleanup = source ? discardPending(source) : Promise.resolve();
			if (!owner) await source?.runtime.dispose();
			else if (shutdown === "quit") owner.runtime.abort(owner.id);
			else if (shutdown)
				for (const child of owner.runtime.tree())
					if (child.parentId === owner.id) owner.runtime.abort(child.id);
			await cleanup;
		}
	}

	function isCurrent(source: SessionBinding, ctx: ExtensionContext): boolean {
		return (
			binding === source && servesSession(ctx, source.manager, source.sessionId)
		);
	}

	function current(ctx: ExtensionContext): SessionBinding | undefined {
		return binding && isCurrent(binding, ctx) ? binding : undefined;
	}

	function release(source: SessionBinding, triggerTurn: boolean): void {
		const messages = source.held.splice(0);
		for (const [index, message] of messages.entries()) {
			const trigger = triggerTurn && index === messages.length - 1;
			pi.sendMessage<Notice["details"]>(message, {
				deliverAs: "followUp",
				triggerTurn: trigger,
			});
			if (!trigger && message.customType === SUBAGENT_RESULT_TYPE)
				source.pendingCompletions.delete(message);
		}
	}

	function releaseIfIdle(source: SessionBinding, ctx: ExtensionContext): void {
		if (isCurrent(source, ctx) && ctx.isIdle()) release(source, true);
	}

	function hold(
		source: SessionBinding,
		ctx: ExtensionContext,
		notice: Notice,
	): void {
		source.held.push(notice);
		releaseIfIdle(source, ctx);
	}

	function takeAccounting(ctx: ExtensionContext): CompletionRecord[] {
		return current(ctx)?.accounting.splice(0) ?? [];
	}

	function appendAccounting(
		event: BoundaryState,
		ctx: ExtensionContext,
	): BoundaryResult | undefined {
		const drafts = takeAccounting(ctx).map((data) => ({
			type: "custom" as const,
			customType: SUBAGENT_USAGE_TYPE,
			data,
		}));
		if (drafts.length) return { entries: [...event.entries, ...drafts] };
	}
	pi.on("turn_end", appendAccounting);
	pi.on("agent_before_settle", appendAccounting);

	function flushAccounting(ctx: ExtensionContext): void {
		for (const record of takeAccounting(ctx))
			pi.appendEntry(SUBAGENT_USAGE_TYPE, record);
	}

	async function deliver(
		source: SessionBinding,
		ctx: ExtensionContext,
		result: SubagentResult,
		canDeliver: () => boolean,
	): Promise<void> {
		const record: CompletionRecord = {
			id: result.id,
			status: result.status,
			usage: result.usage,
		};
		const message = canDeliver()
			? await subagentCompletionMessage(result)
			: undefined;
		if (!message || !canDeliver()) {
			try {
				if (source.manager.getSessionId() === source.sessionId)
					source.manager.appendCustomEntry(SUBAGENT_USAGE_TYPE, record);
			} finally {
				if (message) await discardSubagentCompletion(message);
			}
			return;
		}
		source.pendingCompletions.add(message);
		source.accounting.push(record);
		try {
			if (!owner) {
				hold(source, ctx, message);
				return;
			}
			await source.runtime.notify(owner.id, message, "followUp");
		} catch (error) {
			if (source.pendingCompletions.delete(message))
				await discardSubagentCompletion(message);
			throw error;
		}
	}

	pi.on("agent_start", (_event, ctx) => {
		const source = current(ctx);
		if (!owner || !source) return;
		source.stopWatchingAbort?.();
		const signal = ctx.signal;
		const fence = () => {
			if (!source.runtime.get(owner.id)?.interrupted) source.abortEpoch++;
		};
		signal?.addEventListener("abort", fence, { once: true });
		if (signal?.aborted) fence();
		source.stopWatchingAbort = () =>
			signal?.removeEventListener("abort", fence);
	});
	pi.on("message_end", (event, ctx) => {
		const source = current(ctx);
		if (
			!source ||
			event.message.role !== "custom" ||
			event.message.customType !== SUBAGENT_RESULT_TYPE
		)
			return;
		for (const message of source.pendingCompletions)
			if (message.details === event.message.details)
				source.pendingCompletions.delete(message);
	});
	pi.on("agent_settled", async (event, ctx) => {
		const source = current(ctx);
		if (source) {
			source.stopWatchingAbort?.();
			if (!owner) release(source, !event.aborted);
			else if (event.aborted) {
				const node = source.runtime.get(owner.id);
				if (!node?.interrupted) source.abortEpoch++;
				if (node?.cancelled) await discardPending(source);
			}
		}
		flushAccounting(ctx);
	});
	const releaseAfterIdleWork = (_event: unknown, ctx: ExtensionContext) => {
		const source = binding;
		if (source?.held.length) setImmediate(() => releaseIfIdle(source, ctx));
	};
	pi.on("session_compact", releaseAfterIdleWork);
	pi.on("session_compact_failed", releaseAfterIdleWork);
	pi.on("session_tree", releaseAfterIdleWork);

	pi.on("session_start", async (_event, ctx) => {
		await teardown();
		const manager = ctx.sessionManager as SessionManager;
		const runtime =
			owner?.runtime ??
			createSubagentRuntime({
				rootSessionManager: manager,
				maxDepth: configuredMaxDepth(pi, ctx),
			});
		binding = {
			runtime,
			manager,
			sessionId: manager.getSessionId(),
			abortEpoch: 0,
			accounting: [],
			pendingCompletions: new Set(),
			held: [],
		};
		if (!owner) view?.bind(runtime, ctx);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		flushAccounting(ctx);
		await teardown(event.reason);
	});

	return defineTool({
		name: "subagent",
		label: "Subagent",
		description: "Start an async child agent (reports back when done).",
		parameters: Type.Object({
			instructions: Type.String({ minLength: 1 }),
			model: Type.Optional(Type.String({ minLength: 1 })),
			effort: Type.Optional(Type.Enum(EFFORTS)),
		}),
		outputSchema: Type.Object({
			id: Type.String(),
			status: Type.Literal("running"),
		}),
		executionMode: "parallel",
		async execute(
			_id,
			{ instructions, model, effort },
			signal,
			_onUpdate,
			ctx,
		) {
			signal?.throwIfAborted();
			const source = current(ctx);
			if (!source)
				throw new Error("Subagent parent session is no longer active.");
			const tree = source.runtime;
			const epoch = source.abortEpoch;
			const context = spawnContext(ctx, owner, { model, effort });
			const started = tree.start(parentId, instructions, context);
			const canDeliver = () =>
				isCurrent(source, ctx) &&
				!tree.closed &&
				(!owner ||
					(source.abortEpoch === epoch && !tree.get(owner.id)?.cancelled));
			const completion = started.result
				.then((result) => deliver(source, ctx, result, canDeliver))
				.catch((error: unknown) => {
					if (canDeliver())
						ctx.ui.notify(
							`Subagent ${started.id} completion delivery failed: ${errorMessage(error)}`,
							"error",
						);
					throw error;
				});
			tree.trackCompletion(parentId, completion);
			return subagentReceipt(started.id);
		},
	});
}

function headlessExtension(pi: ExtensionAPI): void {
	const tool = createSubagentIntegration(pi);
	registerSpawnTool(pi, tool);
}
