import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCurrentSystemMessage, type Provider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createBashToolDefinition,
	DefaultResourceLoader,
	type ExtensionContext,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	REPORT_TOOL,
	SUBAGENT_REMINDER_TYPE,
	SUBAGENT_ROLE_SECTION,
} from "../agent/protocol.ts";
import { spawnContext } from "../agent/sessions.ts";
import extension from "../index.ts";
import { ROOT } from "../runtime/index.ts";
import {
	answer,
	checkpoint,
	childExtension,
	hierarchyStream,
	lastCompletion,
	lastCustomMessage,
	lastText,
	model,
	onCleanup,
	remoteBash,
	report,
	response,
	stream,
	taskText,
	spawnContext as testContext,
	testProvider,
	testRuntime,
	toolCall,
} from "./fixtures.ts";

function addedGuidance(guidelines: readonly string[] | undefined): string {
	const stock = createBashToolDefinition(".").promptGuidelines ?? [];
	const added = (guidelines ?? []).filter((line) => !stock.includes(line));
	expect(added).toHaveLength(1);
	return added[0] ?? "";
}

async function setup({
	streamFn = stream((context) => answer(context, "ok")),
	settings = {},
	persist = false,
}: {
	persist?: boolean;
	streamFn?: Provider["streamSimple"];
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
} = {}) {
	const context = await testContext(streamFn);
	const { cwd, agentDir, model, thinkingLevel, modelRuntime } = context;
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
	onCleanup(async () => {
		await parent.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		parent.dispose();
	});
	await parent.bindExtensions({ mode: "rpc" });
	const tree = testRuntime();
	return { parent, tree, context, cwd, agentDir };
}

test("captures the current workspace, model, thinking level and trust decision", () => {
	const ctx = {
		cwd: "/workspace",
		model,
		thinkingLevel: "low",
		isProjectTrusted: () => false,
		sessionManager: { getSessionFile: () => "/sessions/parent.jsonl" },
	} as ExtensionContext;
	expect(spawnContext(ctx)).toEqual({
		cwd: "/workspace",
		model,
		thinkingLevel: "low",
		projectTrusted: false,
		parentSession: "/sessions/parent.jsonl",
	});
	expect(() => spawnContext({ ...ctx, model: undefined })).toThrow(
		"Select a model",
	);
});

test("honors requested effort and resolves requested models against available ones", () => {
	const alternate = { ...model, id: "alternate-model" };
	const other = { ...model, provider: "other-provider" };
	const ctx = {
		cwd: "/workspace",
		model,
		thinkingLevel: "low",
		isProjectTrusted: () => true,
		sessionManager: { getSessionFile: () => undefined },
		modelRegistry: { getAvailable: () => [model, alternate, other] },
	} as unknown as ExtensionContext;
	expect(spawnContext(ctx, undefined, { effort: "max" })).toMatchObject({
		model,
		thinkingLevel: "max",
	});
	for (const reference of ["alternate-model", "test-provider/alternate-model"])
		expect(spawnContext(ctx, undefined, { model: reference })).toMatchObject({
			model: alternate,
			thinkingLevel: "low",
		});
	expect(
		spawnContext(ctx, undefined, { model: "other-provider/test-model" }).model,
	).toBe(other);
	const failure = (reference: string) => {
		try {
			spawnContext(ctx, undefined, { model: reference });
		} catch (error) {
			return String(error);
		}
		throw new Error(`${reference} resolved`);
	};
	const ambiguous = failure("test-model");
	for (const candidate of [
		"test-provider/test-model",
		"other-provider/test-model",
	])
		expect(ambiguous).toContain(candidate);
	expect(ambiguous).not.toContain("alternate-model");
	const unknown = failure("missing");
	for (const candidate of [
		"test-provider/test-model",
		"test-provider/alternate-model",
		"other-provider/test-model",
	])
		expect(unknown).toContain(candidate);
});

test("loads workspace resources into a fresh child of a persistent parent", async () => {
	const { parent, tree, context, agentDir } = await setup({
		persist: true,
		settings: {
			transport: "sse",
			shellCommandPrefix: "export STANDARD_ENV=on_disk;",
		},
		streamFn: stream((context) => answer(context, lastText(context))),
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
	const result = await tree.start(ROOT, "/standard details", context).result;
	const child = tree.get("1")?.session;
	if (!child) throw new Error("Missing child");
	expect(result.output).toBe("STANDARD_TEMPLATE_MARKER details");
	for (const marker of [
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

test("saves each child's session in a directory named after its parent's file", async () => {
	const { parent, tree, context } = await setup({
		persist: true,
		streamFn: hierarchyStream,
	});
	await parent.prompt("an earlier task");
	const parentSession = parent.sessionFile;
	if (!parentSession) throw new Error("Missing parent session file");
	const result = await tree.start(ROOT, "nest:1", { ...context, parentSession })
		.result;
	expect(result.status).toBe("done");
	const child = tree.get("1")?.session;
	const grandchild = tree.get("1.1")?.session;
	if (!child?.sessionFile || !grandchild?.sessionFile)
		throw new Error("Missing child session files");
	expect(dirname(child.sessionFile)).toBe(
		parentSession.replace(/\.jsonl$/, ""),
	);
	expect(dirname(grandchild.sessionFile)).toBe(
		child.sessionFile.replace(/\.jsonl$/, ""),
	);
	for (const [session, owner] of [
		[child, parentSession],
		[grandchild, child.sessionFile],
	] as const) {
		const saved = SessionManager.open(session.sessionFile ?? "");
		expect(saved.getHeader()?.parentSession).toBe(owner);
		expect(JSON.stringify(saved.getEntries())).toBe(
			JSON.stringify(session.sessionManager.getEntries()),
		);
	}
	const listed = await SessionManager.list(context.cwd, dirname(parentSession));
	expect(listed.map((info) => info.path)).toEqual([parentSession]);
});

test("children of an in-memory parent stay in memory", async () => {
	const { tree, context } = await setup({ streamFn: hierarchyStream });
	await tree.start(ROOT, "nest:1", context).result;
	expect(tree.tree()).toHaveLength(2);
	for (const node of tree.tree())
		expect(node.session?.sessionFile).toBeUndefined();
});

test("only a child whose task names a `skill://` path is told to skip default skill loading", async () => {
	const { parent, tree, context, agentDir } = await setup({
		streamFn: hierarchyStream,
	});
	await mkdir(join(agentDir, "skills", "standard"), { recursive: true });
	await writeFile(
		join(agentDir, "skills", "standard", "SKILL.md"),
		"---\nname: standard\ndescription: STANDARD_SKILL_MARKER\n---\nSkill instructions.",
	);
	const base = parent.resourceLoader.getAppendSystemPrompt();
	await tree.start(ROOT, "Follow skill://standard/references/role.md.", context)
		.result;
	await tree.start(ROOT, "plain task", context).result;
	const appended = (id: string) =>
		tree.get(id)?.session?.resourceLoader.getAppendSystemPrompt() ?? [];
	const guidance = appended("1").at(-1) ?? "";
	expect(appended("1")).toEqual([...base, guidance]);
	expect(base).not.toContain(guidance);
	expect(tree.get("1")?.session?.systemPrompt).toContain(guidance);
	expect(appended("2")).toEqual(base);
	expect(tree.get("2")?.session?.systemPrompt).not.toContain(guidance);
	expect(parent.systemPrompt).not.toContain(guidance);
	for (const id of ["1", "2"])
		expect(tree.get(id)?.session?.systemPrompt).toContain(
			"STANDARD_SKILL_MARKER",
		);
});

test("background guidance reaches every tracked bash tool, descendants included", async () => {
	const { parent, tree, context } = await setup({ streamFn: hierarchyStream });
	const guidelines = parent.getToolDefinition("bash")?.promptGuidelines;
	const backgroundGuidance = addedGuidance(guidelines);
	expect(parent.systemPrompt).toContain(backgroundGuidance);
	await tree.start(ROOT, "nest:1", context).result;
	expect(tree.tree().map((node) => node.id)).toEqual(["1", "1.1"]);
	for (const node of tree.tree()) {
		expect(node.session?.getToolDefinition("bash")?.promptGuidelines).toEqual(
			guidelines,
		);
		expect(node.session?.systemPrompt).toContain(backgroundGuidance);
	}
});

test.each(["inactive", "overridden"] as const)(
	"does not advertise background tracking when bash is %s",
	async (mode) => {
		const { parent, tree, context } = await setup({
			settings: mode === "inactive" ? { defaultTools: ["read"] } : {},
		});
		const guidelines = parent.getToolDefinition("bash")?.promptGuidelines;
		const backgroundGuidance = addedGuidance(guidelines);
		if (mode === "overridden")
			await childExtension(context, "behavior", remoteBash);
		await tree.start(ROOT, "child", context).result;
		const child = tree.get("1")?.session;
		if (!child) throw new Error("Missing child");
		if (mode === "inactive") {
			expect(child.getActiveToolNames()).not.toContain("bash");
			expect(child.getToolDefinition("bash")?.promptGuidelines).toEqual(
				guidelines,
			);
		} else {
			expect(child.getToolDefinition("bash")?.promptGuidelines).toEqual([
				"REMOTE_BASH_MARKER",
			]);
			expect(child.systemPrompt).toContain("REMOTE_BASH_MARKER");
		}
		expect(child.systemPrompt).not.toContain(backgroundGuidance);
		expect(child.resourceLoader.getAppendSystemPrompt()).not.toContain(
			backgroundGuidance,
		);
	},
);

test("provides machine-facing delegation in children without loading UI registrations", async () => {
	const { parent, tree, context } = await setup();
	await tree.start(ROOT, "child", context).result;
	const child = tree.get("1")?.session;
	if (!child) throw new Error("Missing child");
	const tool = child.getToolDefinition("subagent");
	expect(tool).toBeDefined();
	expect(child.getActiveToolNames()).toContain(REPORT_TOOL);
	expect(parent.getToolDefinition(REPORT_TOOL)).toBeUndefined();
	expect(child.systemPrompt).not.toContain(REPORT_TOOL);
	expect(tool?.renderCall).toBeUndefined();
	expect(tool?.renderResult).toBeUndefined();
	const extensions = child.resourceLoader.getExtensions();
	expect(extensions.errors).toEqual([]);
	const delegation = extensions.extensions.find((entry) =>
		entry.tools.has("subagent"),
	);
	expect(delegation).toBeDefined();
	expect(delegation?.commands.size).toBe(0);
	expect(delegation?.shortcuts.size).toBe(0);
	expect(delegation?.toolRenderers ?? []).toHaveLength(0);
	expect(child.systemPrompt).not.toContain("/subagents");
});

test("a subagent's prompt gives its role while its parent's task runs, and drops it once the user takes over", async () => {
	const roles = new Map<string, string | null | undefined>();
	const { parent, tree, context } = await setup({
		streamFn: stream((context) => {
			const reminded = lastCustomMessage(context, SUBAGENT_REMINDER_TYPE);
			roles.set(
				reminded ? "reminder" : lastText(context),
				getCurrentSystemMessage(context.messages)?.sections?.[
					SUBAGENT_ROLE_SECTION
				],
			);
			return reminded ? report("task done") : response(lastText(context));
		}),
	});
	await parent.prompt("root prompt");
	expect(await tree.start(ROOT, "task", context).result).toMatchObject({
		status: "done",
		output: "task done",
	});
	await tree.send("1", "takeover");
	expect([...roles.keys()]).toEqual([
		"root prompt",
		"task",
		"reminder",
		"takeover",
	]);
	expect(roles.get("root prompt")).toBeUndefined();
	expect(roles.get("task")).toContain(REPORT_TOOL);
	expect(roles.get("reminder")).toBe(roles.get("task"));
	expect(roles.get("takeover")).toBeUndefined();
});

test("configured web search remains available throughout nested delegation", async () => {
	const { tree, context } = await setup({
		settings: { defaultTools: ["read", "grep"] },
		streamFn: stream((context) => {
			const text = lastText(context);
			const completion = lastCompletion(context);
			if (completion) return answer(context, completion.output);
			if (context.messages.at(-1)?.role === "toolResult")
				return taskText(context) === "delegate search"
					? response("searching")
					: answer(context, text);
			return text === "delegate search"
				? toolCall("subagent", { instructions: "search" })
				: toolCall("web_search", { query: "pi" });
		}),
	});
	await childExtension(context, "behavior", (pi) => {
		pi.registerTool({
			name: "web_search",
			label: "Web search",
			description: "Test search tool",
			parameters: Type.Object({ query: Type.String() }),
			async execute(_id, { query }, _signal, _onUpdate, ctx) {
				const text = `${query}:${ctx.sessionManager.getSessionId()}`;
				return { content: [{ type: "text", text }], details: undefined };
			},
		});
	});
	const result = await tree.start(ROOT, "delegate search", context).result;
	expect(result.status).toBe("done");
	expect(result.output).toBe(`pi:${tree.get("1.1")?.session?.sessionId}`);
	expect(tree.tree()).toHaveLength(2);
	for (const node of tree.tree()) {
		expect(node.session?.getActiveToolNames().toSorted()).toEqual(
			["read", "grep", "web_search", "subagent", REPORT_TOOL].toSorted(),
		);
	}
});

test("runs recursive delegation through pi's codemode extension", async () => {
	const { tree, context } = await setup({
		settings: { defaultTools: ["+codemode"] },
		streamFn: stream((context) => {
			const text = lastText(context);
			const completion = lastCompletion(context);
			if (completion) return answer(context, completion.output);
			if (context.messages.at(-1)?.role === "toolResult")
				return taskText(context) === "delegate"
					? response("delegated")
					: answer(context, text);
			return toolCall("codemode", {
				code:
					lastText(context) === "delegate"
						? 'return await tools.subagent({ instructions: "read instructions" });'
						: 'return await tools.read({ path: "AGENTS.md" });',
			});
		}),
	});
	const result = await tree.start(ROOT, "delegate", context).result;
	expect(result.status).toBe("done");
	expect(result.output).toContain("PROJECT_INSTRUCTIONS_MARKER");
	expect(result.usage?.totalTokens).toBe(15);
	expect(tree.tree().map((node) => node.id)).toEqual(["1", "1.1"]);
});

test("uses configured MCP servers during nested delegation", async () => {
	const { tree, context, cwd } = await setup({
		streamFn: stream((context) => {
			const completion = lastCompletion(context);
			if (completion) return answer(context, completion.output);
			const delegating = taskText(context) === "delegate";
			if (context.messages.at(-1)?.role === "toolResult")
				return delegating
					? response("delegated")
					: answer(context, lastText(context));
			return delegating
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
	const result = await tree.start(ROOT, "delegate", context).result;
	expect(result.status).toBe("done");
	expect(result.output).toBe("MCP_MARKER");
	expect(tree.tree().map((node) => node.id)).toEqual(["1", "1.1"]);
});

test.each([false, true])(
	"respects the project-trust decision (%p) when discovering project settings and resources",
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
		await tree.start(ROOT, "child", { ...context, projectTrusted }).result;
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
				? answer(context, lastText(context))
				: lastText(context) === "write"
					? toolCall("write", { path: "blocked.txt", content: "blocked" })
					: toolCall("read", { path: "AGENTS.md" }),
		),
	});
	await childExtension(context, "behavior", (pi) => {
		pi.on("tool_call", (event) =>
			event.toolName === "write"
				? { block: true, reason: "POLICY_BLOCKED" }
				: undefined,
		);
		pi.on("tool_result", (event, ctx) =>
			event.toolName === "read"
				? {
						content: [
							{ type: "text", text: ctx.sessionManager.getSessionId() },
						],
					}
				: undefined,
		);
	});
	const blocked = await tree.start(ROOT, "write", context).result;
	expect(blocked.output).toBe("POLICY_BLOCKED");
	expect(await Bun.file(join(cwd, "blocked.txt")).exists()).toBe(false);
	const result = await tree.start(ROOT, "read", context).result;
	expect(result.output).toBe(tree.get("2")?.session?.sessionId ?? "missing");
	expect(JSON.stringify(parent.messages)).not.toContain("POLICY_BLOCKED");
});

test("a normally installed subagents extension shares the explicit child ownership and hierarchy", async () => {
	const { tree, context, agentDir } = await setup({
		streamFn: hierarchyStream,
	});
	const settings = SettingsManager.create(context.cwd, agentDir).getSettings();
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			...settings,
			extensions: [new URL("../index.ts", import.meta.url).pathname],
		}),
	);
	const result = await tree.start(ROOT, "nest:2", context).result;
	expect(result.status).toBe("done");
	expect(result.output).toBe("hello");
	expect(tree.tree().map((node) => node.id)).toEqual(["1", "1.1", "1.1.1"]);
	for (const node of tree.tree()) {
		const extensions = node.session?.resourceLoader.getExtensions();
		expect(extensions?.errors).toEqual([]);
		for (const tool of ["subagent", REPORT_TOOL])
			expect(
				extensions?.extensions.filter((entry) => entry.tools.has(tool)),
			).toHaveLength(1);
	}
});

test("nested spawning uses the child's current public model and thinking selection", async () => {
	const context = await testContext();
	const tree = testRuntime();
	await tree.start(ROOT, "say hello", context).result;
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
		streamFn: stream((context) =>
			attempts++ === 0
				? response("", {
						stopReason: "error",
						errorMessage: "500 server error",
					})
				: answer(context, "recovered"),
		),
	});
	const result = await tree.start(ROOT, "retry", context).result;
	expect(result.status).toBe("done");
	expect(result.output).toBe("recovered");
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
			report(output, {
				usage: { ...response("").usage, input: 90000, totalTokens: 90002 },
			}),
		),
	});
	await childExtension(context, "behavior", (pi) => {
		pi.on("session_before_compact", ({ preparation }) => ({
			compaction: {
				summary: "COMPACTION_MARKER",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: response("summary").usage,
			},
		}));
	});
	const result = await tree.start(ROOT, "compact", context).result;
	expect(result.status).toBe("done");
	expect(result.output).toBe(output);
	expect(
		tree
			.get("1")
			?.session?.sessionManager.getEntries()
			.some((entry) => entry.type === "compaction"),
	).toBe(true);
	expect(result.usage?.totalTokens).toBe(90005);
});

test("dispatches standard extension commands without sending them to the model, which then reports", async () => {
	const requests: string[] = [];
	const { tree, context } = await setup({
		streamFn: stream((context) => {
			requests.push(JSON.stringify(context.messages));
			return report("pong");
		}),
	});
	await childExtension(context, "behavior", (pi) => {
		pi.registerCommand("ping", {
			description: "Ping",
			handler: async () => {
				pi.sendMessage({
					customType: "ping",
					content: "PING_MARKER",
					display: false,
				});
			},
		});
	});
	const result = await tree.start(ROOT, "/ping", context).result;
	expect(result).toMatchObject({ status: "done", output: "pong" });
	expect(requests).toHaveLength(1);
	expect(requests[0]).toContain("PING_MARKER");
	expect(requests[0]).not.toContain("/ping");
});

test("cancellation during async standard input hooks stops the later agent loop", async () => {
	const hook = checkpoint();
	let modelCalls = 0;
	const { tree, context } = await setup({
		streamFn: stream(() => {
			modelCalls++;
			return response("must not run");
		}),
	});
	await childExtension(context, "behavior", (pi) => {
		pi.on("input", () => hook.pass());
	});
	const result = tree.start(ROOT, "wait", context).result;
	await hook.reached;
	tree.abort("1");
	hook.open();
	expect((await result).status).toBe("aborted");
	expect(tree.get("1")?.status).toBe("aborted");
	expect(modelCalls).toBe(0);
});
