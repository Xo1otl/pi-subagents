import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	createEventBus,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	type EventBus,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionFactory,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SessionOwner, SpawnContext } from "../runtime/index.ts";
import { delegatedCommands } from "./commands.ts";
import { SUBAGENT_RESUME_TYPE } from "./protocol.ts";

/** Each delegated session has its own event bus, which answers this request.
 * Unlike module state, the bus reaches every copy of this extension, including
 * a configured installation that Pi's loader evaluates separately.
 */
const OWNER_REQUEST = "pi-subagents:owner";

interface OwnerRequest {
	owner?: SessionOwner;
}

/** The subagent a loading extension serves; undefined in a root session. */
export function sessionOwner(events: EventBus): SessionOwner | undefined {
	const request: OwnerRequest = {};
	// Bus handlers run synchronously within emit.
	events.emit(OWNER_REQUEST, request);
	return request.owner;
}

/** Children inherit their parent's configuration, then its current selections,
 * unless the request names a model (`provider/id` or a unique `id`) or an effort.
 */
export function spawnContext(
	ctx: ExtensionContext,
	owner?: SessionOwner,
	{ model, effort }: { model?: string; effort?: ThinkingLevel } = {},
): SpawnContext {
	if (!ctx.model) throw new Error("Select a model before spawning a subagent.");
	return {
		...owner?.runtime.get(owner.id)?.context,
		cwd: ctx.cwd,
		model: model ? resolveModel(ctx, model) : ctx.model,
		thinkingLevel: effort ?? ctx.thinkingLevel,
		projectTrusted: ctx.isProjectTrusted(),
	};
}

function resolveModel(ctx: ExtensionContext, reference: string): Model<Api> {
	const available = ctx.modelRegistry.getAvailable();
	const qualified = available.filter(
		({ provider, id }) => `${provider}/${id}` === reference,
	);
	const matches = qualified.length
		? qualified
		: available.filter(({ id }) => id === reference);
	if (matches.length === 1 && matches[0]) return matches[0];
	const list = (models: Model<Api>[]) =>
		models.map(({ provider, id }) => `${provider}/${id}`).join(", ");
	throw new Error(
		matches.length
			? `Ambiguous model "${reference}": ${list(matches)}`
			: `Unknown model "${reference}". Available: ${list(available)}`,
	);
}

export async function createChildSession(
	context: SpawnContext,
	owner: SessionOwner,
	onCreated: (session: AgentSession) => void,
	onError: (error: ExtensionError) => void,
	extension: ExtensionFactory,
): Promise<void> {
	const agentDir = context.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(context.cwd, agentDir, {
		projectTrusted: context.projectTrusted,
	});
	// Use the supported decision hook rather than changing the configured policy.
	// Idle refreshes must not add charges after this run's result was captured.
	const ownedWarming: ExtensionFactory = (pi) => {
		pi.on("cache_warming_decision", () => {
			if (owner.runtime.get(owner.id)?.status !== "running")
				return { action: "stop" };
		});
	};
	const eventBus = createEventBus();
	eventBus.on(OWNER_REQUEST, (request) => {
		(request as OwnerRequest).owner = owner;
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: context.cwd,
		agentDir,
		settingsManager,
		eventBus,
		appendSystemPromptOverride: (base) => [
			...base,
			"Skip default skill-file loading for direct `skill://` paths.",
		],
		extensionFactories: [
			ownedWarming,
			{ name: "subagent-commands", factory: delegatedCommands(owner) },
			// A configured installation takes precedence, without duplicate registrations.
			// Otherwise children receive only the machine-facing extension, not the UI entrypoint.
			{
				name: "subagents",
				factory: extension,
				replaceable: true,
			},
			{
				name: "codemode",
				factory: createCodemodeExtension(),
				builtin: true,
				replaceable: true,
			},
			{
				name: "tool-search",
				factory: createToolSearchExtension(),
				builtin: true,
				replaceable: true,
			},
			{
				name: "mcp",
				factory: createMcpExtension(),
				builtin: true,
				replaceable: true,
			},
		],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(context.cwd);
	const { session } = await createAgentSession({
		cwd: context.cwd,
		agentDir,
		model: context.model,
		thinkingLevel: context.thinkingLevel,
		modelRuntime: context.modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager,
	});
	// Publication transfers cleanup to the runtime, including failed binding.
	onCreated(session);
	// Headless but long-lived: command groups and descendants may outlive a turn,
	// and the agent remains available for conversation until the runtime settles.
	await session.bindExtensions({
		mode: "rpc",
		shutdownHandler: () => owner.runtime.abort(owner.id),
		onError,
	});
}

/** Return a delegated run to its task once it has answered the user. The
 * promise settles with the turn, so startup failures fail the run.
 */
export function resumeChildSession(session: AgentSession): Promise<void> {
	return session.sendCustomMessage(
		{
			customType: SUBAGENT_RESUME_TYPE,
			content:
				"Resume the original task; if done, report back on the full task (including user changes), as the parent hasn't seen this chat.",
			display: true,
		},
		{ triggerTurn: true },
	);
}

export async function disposeChildSession(
	session: AgentSession,
): Promise<void> {
	try {
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
	} finally {
		session.dispose();
	}
}
