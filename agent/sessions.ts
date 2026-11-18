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
	type ExtensionFactory,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	SessionOwner,
	SessionRequest,
	SpawnContext,
} from "../runtime/index.ts";
import { delegatedCommands } from "./commands.ts";
import { REPORT_TOOL, SUBAGENT_REMINDER_TYPE } from "./protocol.ts";

const OWNER_REQUEST = "pi-subagents:owner";

interface OwnerRequest {
	owner?: SessionOwner;
}

/** A parent following a skill delegates by naming its files, e.g. `Follow
 * skill://auto-research/references/reviewer.md.`: the skill's SKILL.md is the
 * parent's, and reading it too derails the child. Other tasks load skills as
 * usual, so only these gain the line.
 */
const SKILL_PATH_GUIDANCE =
	"Skip default skill-file loading for direct `skill://` paths.";

export function sessionOwner(events: EventBus): SessionOwner | undefined {
	const request: OwnerRequest = {};
	events.emit(OWNER_REQUEST, request);
	return request.owner;
}

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
		parentSession: ctx.sessionManager.getSessionFile(),
	};
}

function childSessionManager({
	cwd,
	parentSession,
}: SpawnContext): SessionManager {
	if (!parentSession) return SessionManager.inMemory(cwd);
	const stem = parentSession.replace(/\.jsonl$/, "");
	const directory = stem === parentSession ? `${stem}.subagents` : stem;
	return SessionManager.create(cwd, directory, { parentSession });
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
	{ context, owner, onCreated, onError }: SessionRequest,
	extension: ExtensionFactory,
): Promise<void> {
	const agentDir = context.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(context.cwd, agentDir, {
		projectTrusted: context.projectTrusted,
	});
	const ownedWarming: ExtensionFactory = (pi) => {
		pi.on("cache_warming_decision", () => {
			if (owner.runtime.get(owner.id)?.status !== "running")
				return { action: "stop" };
		});
	};
	const namesSkillPaths =
		owner.runtime.get(owner.id)?.instructions.includes("skill://") === true;
	const eventBus = createEventBus();
	eventBus.on(OWNER_REQUEST, (request) => {
		(request as OwnerRequest).owner = owner;
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: context.cwd,
		agentDir,
		settingsManager,
		eventBus,
		appendSystemPromptOverride: (base) =>
			namesSkillPaths ? [...base, SKILL_PATH_GUIDANCE] : base,
		extensionFactories: [
			ownedWarming,
			{ name: "subagent-commands", factory: delegatedCommands(owner) },
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
	const sessionManager = childSessionManager(context);
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
	onCreated(session);
	await session.bindExtensions({
		mode: "rpc",
		shutdownHandler: () => owner.runtime.abort(owner.id),
		onError,
	});
}

export function remindChildSession(session: AgentSession): Promise<void> {
	return session.sendCustomMessage(
		{
			customType: SUBAGENT_REMINDER_TYPE,
			content: `Not reported. Task incomplete → continue; done → \`${REPORT_TOOL}\`.`,
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
