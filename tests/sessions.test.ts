import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import {
	createSubagents,
	ROOT,
	type SpawnContext,
	type Subagents,
} from "../runtime.ts";
import { spawnContext } from "../sessions.ts";
import {
	lastText,
	model,
	response,
	stream,
	spawnContext as testContext,
	testProvider,
	toolCall,
	until,
} from "./fixtures.ts";

const parents: AgentSession[] = [];
const trees: Subagents[] = [];
afterEach(async () => {
	await Promise.all(trees.splice(0).map((tree) => tree.dispose()));
	for (const parent of parents.splice(0)) {
		await parent.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		parent.dispose();
	}
});

async function setup({
	streamFn = stream(() => response("ok")),
	settings = {},
	persist = false,
}: {
	persist?: boolean;
	streamFn?: Provider["streamSimple"];
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
} = {}) {
	const context = await testContext(streamFn);
	const { cwd, agentDir, model, thinkingLevel, modelRuntime } = context;
	if (!agentDir) throw new Error("Missing test agent directory");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ ...settingsManager.getSettings(), ...settings }),
	);
	await settingsManager.reload();
	await writeFile(join(cwd, "AGENTS.md"), "PROJECT_INSTRUCTIONS_MARKER");
	await writeFile(join(agentDir, "AGENTS.md"), "USER_INSTRUCTIONS_MARKER");
	await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "APPEND_SYSTEM_MARKER");
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [extension],
	});
	await resourceLoader.reload();
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		modelRuntime,
		model,
		thinkingLevel,
		sessionManager: persist
			? SessionManager.create(cwd, join(agentDir, "sessions"))
			: SessionManager.inMemory(cwd),
	});
	parents.push(parent);
	await parent.bindExtensions({ mode: "print" });
	const tree = createSubagents();
	trees.push(tree);
	return { parent, tree, context, cwd, agentDir };
}

async function configuredExtension(
	context: SpawnContext,
	source: string,
): Promise<void> {
	if (!context.agentDir) throw new Error("Missing test agent directory");
	const directory = join(context.agentDir, "extensions");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "behavior.js"),
		`export default function(pi) { ${source} }`,
	);
}

test("captures the current workspace, model, thinking level and trust decision", async () => {
	const context = await testContext();
	const ctx = {
		cwd: context.cwd,
		model: context.model,
		thinkingLevel: "low",
		isProjectTrusted: () => false,
	} as ExtensionContext;
	expect(spawnContext(ctx)).toEqual({
		cwd: context.cwd,
		model: context.model,
		thinkingLevel: "low",
		projectTrusted: false,
	});
	expect(() => spawnContext({ ...ctx, model: undefined })).toThrow(
		"Select a model",
	);
});

test("loads workspace instructions, skills, templates and settings into a fresh conversation", async () => {
	const { parent, tree, context, agentDir } = await setup({
		settings: {
			transport: "sse",
			shellCommandPrefix: "export STANDARD_ENV=on_disk;",
		},
		streamFn: stream((context) => response(lastText(context))),
	});
	await mkdir(join(agentDir, "skills", "standard"), { recursive: true });
	await writeFile(
		join(agentDir, "skills", "standard", "SKILL.md"),
		"---\nname: standard\ndescription: STANDARD_SKILL_MARKER\n---\nSkill instructions.",
	);
	await mkdir(join(agentDir, "prompts"));
	await writeFile(
		join(agentDir, "prompts", "standard.md"),
		"STANDARD_TEMPLATE_MARKER $1",
	);
	await parent.prompt("an earlier task");
	const result = await tree.spawn(ROOT, "/standard details", context);
	const child = tree.get("1")?.session;
	if (!child) throw new Error("Missing child");
	expect(result.content).toEqual([
		{ type: "text", text: "STANDARD_TEMPLATE_MARKER details" },
	]);
	for (const marker of [
		"expert coding assistant",
		"PROJECT_INSTRUCTIONS_MARKER",
		"USER_INSTRUCTIONS_MARKER",
		"APPEND_SYSTEM_MARKER",
		"STANDARD_SKILL_MARKER",
	])
		expect(child.systemPrompt).toContain(marker);
	expect(child.settingsManager.getSettings().transport).toBe("sse");
	expect(child.settingsManager.getSettings().shellCommandPrefix).toBe(
		"export STANDARD_ENV=on_disk;",
	);
	expect(child.model).toEqual(parent.model);
	expect(child.thinkingLevel).toBe(parent.thinkingLevel);
	expect(child.sessionManager.getCwd()).toBe(context.cwd);
	expect(JSON.stringify(child.messages)).not.toContain("an earlier task");
});

test("loads the same subagents extension in every session", async () => {
	const { tree, context } = await setup();
	await tree.spawn(ROOT, "child", context);
	const child = tree.get("1")?.session;
	if (!child) throw new Error("Missing child");
	expect(child.getToolDefinition("subagent")).toBeDefined();
	await child.prompt("/subagents depth 0");
	expect(tree.maxDepth).toBe(0);
	await child.prompt("/subagents depth 3");
	expect(tree.maxDepth).toBe(3);
});

test("configured web search remains available throughout nested delegation", async () => {
	const { tree, context } = await setup({
		settings: { defaultTools: ["read", "grep"] },
		streamFn: stream((context) => {
			if (context.messages.at(-1)?.role === "toolResult")
				return response(lastText(context));
			return lastText(context) === "delegate search"
				? toolCall("subagent", { instructions: "search" })
				: toolCall("web_search", { query: "pi" });
		}),
	});
	await configuredExtension(
		context,
		`
		pi.registerTool({
			name: "web_search", label: "Web search", description: "Test search tool",
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
			async execute(_id, args, _signal, _onUpdate, ctx) {
				return { content: [{ type: "text", text: args.query + ":" + ctx.sessionManager.getSessionId() }], details: undefined };
			}
		});
	`,
	);
	const result = await tree.spawn(ROOT, "delegate search", context);
	expect(result.isError).toBe(false);
	expect(result.content).toEqual([
		{ type: "text", text: `pi:${tree.get("1.1")?.session?.sessionId}` },
	]);
	expect(tree.tree()).toHaveLength(2);
	for (const node of tree.tree()) {
		expect(node.session?.getActiveToolNames().toSorted()).toEqual(
			["read", "grep", "web_search", "subagent"].toSorted(),
		);
	}
});

test("runs recursive delegation through pi's codemode extension", async () => {
	const { tree, context } = await setup({
		settings: { defaultTools: ["+codemode"] },
		streamFn: stream((context) => {
			if (context.messages.at(-1)?.role === "toolResult")
				return response(lastText(context));
			return toolCall("codemode", {
				code:
					lastText(context) === "delegate"
						? 'return await tools.subagent({ instructions: "read instructions" });'
						: 'return await tools.read({ path: "AGENTS.md" });',
			});
		}),
	});
	const result = await tree.spawn(ROOT, "delegate", context);
	expect(result.isError).toBe(false);
	expect(JSON.stringify(result.content)).toContain(
		"PROJECT_INSTRUCTIONS_MARKER",
	);
	expect(result.usage?.totalTokens).toBe(12);
	expect(tree.tree().map((node) => node.id)).toEqual(["1", "1.1"]);
});

test("uses configured MCP servers during nested delegation", async () => {
	const { tree, context, cwd } = await setup({
		streamFn: stream((context) => {
			if (context.messages.at(-1)?.role === "toolResult")
				return response(lastText(context));
			return lastText(context) === "delegate"
				? toolCall("subagent", { instructions: "echo" })
				: toolCall("mcp__test__echo", { text: "MCP_MARKER" });
		}),
	});
	await mkdir(join(cwd, ".pi"));
	await writeFile(
		join(cwd, ".pi", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				test: {
					command: process.execPath,
					args: [new URL("./mcp-server.js", import.meta.url).pathname],
					exposure: "direct",
				},
			},
		}),
	);
	const result = await tree.spawn(ROOT, "delegate", context);
	expect(result.isError).toBe(false);
	expect(result.content).toEqual([{ type: "text", text: "MCP_MARKER" }]);
	expect(tree.tree().map((node) => node.id)).toEqual(["1", "1.1"]);
});

test.each([false, true])(
	"respects the project-trust decision (%s) when discovering project settings and resources",
	async (projectTrusted) => {
		const { tree, context, cwd } = await setup({
			settings: { transport: "sse" },
		});
		await mkdir(join(cwd, ".pi"));
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ transport: "websocket" }),
		);
		await writeFile(join(cwd, ".pi", "SYSTEM.md"), "PROJECT_SYSTEM_MARKER");
		await tree.spawn(ROOT, "child", { ...context, projectTrusted });
		const child = tree.get("1")?.session;
		expect(child?.settingsManager.isProjectTrusted()).toBe(projectTrusted);
		expect(child?.settingsManager.getSettings().transport).toBe(
			projectTrusted ? "websocket" : "sse",
		);
		expect(child?.systemPrompt.includes("PROJECT_SYSTEM_MARKER")).toBe(
			projectTrusted,
		);
		expect(child?.systemPrompt).toContain("PROJECT_INSTRUCTIONS_MARKER");
	},
);

test("runs standard extension permission and result hooks in the child's context", async () => {
	const { parent, tree, context, cwd } = await setup({
		streamFn: stream((context) =>
			context.messages.at(-1)?.role === "toolResult"
				? response(lastText(context))
				: lastText(context) === "write"
					? toolCall("write", { path: "blocked.txt", content: "blocked" })
					: toolCall("read", { path: "AGENTS.md" }),
		),
	});
	await configuredExtension(
		context,
		`
		pi.on("tool_call", (event) => {
			if (event.toolName === "write") return { block: true, reason: "POLICY_BLOCKED" };
		});
		pi.on("tool_result", (event, ctx) => {
			if (event.toolName === "read") return { content: [{ type: "text", text: ctx.sessionManager.getSessionId() }] };
		});
	`,
	);
	const blocked = await tree.spawn(ROOT, "write", context);
	expect(blocked.content).toEqual([{ type: "text", text: "POLICY_BLOCKED" }]);
	expect(await Bun.file(join(cwd, "blocked.txt")).exists()).toBe(false);
	const result = await tree.spawn(ROOT, "read", context);
	expect(result.content).toEqual([
		{ type: "text", text: tree.get("2")?.session?.sessionId ?? "missing" },
	]);
	expect(JSON.stringify(parent.messages)).not.toContain("POLICY_BLOCKED");
});

test("a normally installed subagents extension shares the explicit child ownership and hierarchy", async () => {
	const { tree, context, agentDir } = await setup();
	const settings = SettingsManager.create(context.cwd, agentDir).getSettings();
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			...settings,
			extensions: [new URL("../index.ts", import.meta.url).pathname],
		}),
	);
	const recursive = await testContext();
	const result = await tree.spawn(ROOT, "nest:2", {
		...context,
		modelRuntime: recursive.modelRuntime,
	});
	expect(result.isError).toBe(false);
	expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	expect(tree.tree().map((node) => node.id)).toEqual(["1", "1.1", "1.1.1"]);
	for (const node of tree.tree()) {
		const extensions = node.session?.resourceLoader.getExtensions();
		expect(extensions?.errors).toEqual([]);
		expect(
			extensions?.extensions.filter((entry) => entry.tools.has("subagent")),
		).toHaveLength(1);
	}
});

test("nested spawning uses the child's current public model and thinking selection", async () => {
	const context = await testContext();
	const tree = createSubagents();
	trees.push(tree);
	await tree.spawn(ROOT, "say hello", context);
	const alternate = { ...model, id: "alternate-model" };
	context.modelRuntime?.registerNativeProvider({
		...testProvider(),
		getModels: () => [model, alternate],
	});
	await tree.get("1")?.session?.setModel(alternate);
	tree.get("1")?.session?.setThinkingLevel("low");
	await tree.send("1", "nest:1");
	expect(tree.get("1.1")?.session?.model).toEqual(alternate);
	expect(tree.get("1.1")?.session?.thinkingLevel).toBe("low");
});

test("uses retries from standard settings and bills all attempts", async () => {
	let attempts = 0;
	const { tree, context } = await setup({
		settings: {
			retry: {
				enabled: true,
				maxRetries: 1,
				baseDelayMs: 1,
				maxAgentDelayMs: 1,
			},
		},
		streamFn: stream(() =>
			attempts++ === 0
				? response("", {
						stopReason: "error",
						errorMessage: "500 server error",
					})
				: response("recovered"),
		),
	});
	const result = await tree.spawn(ROOT, "retry", context);
	expect(result.isError).toBe(false);
	expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	expect(attempts).toBe(2);
	expect(result.usage?.totalTokens).toBe(6);
});

test("standard compaction preserves final output and summarization usage", async () => {
	const output = "final output survives ".repeat(20);
	const { tree, context } = await setup({
		settings: {
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 10 },
		},
		streamFn: stream(() =>
			response(output, {
				usage: { ...response("").usage, input: 90000, totalTokens: 90002 },
			}),
		),
	});
	await configuredExtension(
		context,
		`
		pi.on("session_before_compact", (event) => ({ compaction: {
			summary: "COMPACTION_MARKER",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			usage: ${JSON.stringify(response("summary").usage)},
		} }));
	`,
	);
	const result = await tree.spawn(ROOT, "compact", context);
	expect(result.isError).toBe(false);
	expect(result.content).toEqual([{ type: "text", text: output }]);
	expect(
		tree
			.get("1")
			?.session?.sessionManager.getEntries()
			.some((entry) => entry.type === "compaction"),
	).toBe(true);
	expect(result.usage?.totalTokens).toBe(90005);
});

test("dispatches standard extension commands without sending them to the model", async () => {
	let modelCalls = 0;
	const { tree, context } = await setup({
		streamFn: stream(() => {
			modelCalls++;
			return response("unused");
		}),
	});
	await configuredExtension(
		context,
		`
		pi.registerCommand("ping", { description: "Ping", handler: async () => {
			pi.sendMessage({ customType: "ping", content: "PING_MARKER", display: false });
		} });
	`,
	);
	const result = await tree.spawn(ROOT, "/ping", context);
	expect(result.isError).toBe(false);
	expect(modelCalls).toBe(0);
	expect(JSON.stringify(tree.get("1")?.session?.messages)).toContain(
		"PING_MARKER",
	);
});

test("cancellation during async standard input hooks stops the later agent loop", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered = false;
	let modelCalls = 0;
	const { tree, context } = await setup({
		streamFn: stream(() => {
			modelCalls++;
			return response("must not run");
		}),
	});
	const name = `pi-subagents.test-input.${crypto.randomUUID()}`;
	const key = Symbol.for(name);
	const shared = globalThis as typeof globalThis & {
		[key]?: () => Promise<void>;
	};
	shared[key] = async () => {
		entered = true;
		await gate;
	};
	try {
		await configuredExtension(
			context,
			`pi.on("input", () => globalThis[Symbol.for("${name}")]());`,
		);
		const result = tree.spawn(ROOT, "wait", context);
		await until(() => entered);
		tree.abort("1");
		release();
		expect((await result).isError).toBe(true);
		expect(tree.get("1")?.status).toBe("aborted");
		expect(modelCalls).toBe(0);
	} finally {
		release();
		delete shared[key];
	}
});

test("children are ephemeral even when the parent persists its conversation", async () => {
	const { parent, tree, context } = await setup({ persist: true });
	await parent.prompt("ROOT_PERSISTED_HISTORY");
	await tree.spawn(ROOT, "child", context);
	expect(parent.sessionFile).toBeDefined();
	expect(tree.get("1")?.session?.sessionFile).toBeUndefined();
	expect(JSON.stringify(tree.get("1")?.session?.messages)).not.toContain(
		"ROOT_PERSISTED_HISTORY",
	);
});
