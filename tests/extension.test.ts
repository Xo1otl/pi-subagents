import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	lastText,
	model,
	response,
	stream,
	testProvider,
	toolCall,
} from "./fixtures.ts";

test("loads as a real pi extension and delegates runtime instructions without intermediate parent events", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-sdk-"));
	const settings = SettingsManager.inMemory({
		cacheWarming: "off",
		compaction: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		additionalExtensionPaths: [
			new URL("../index.ts", import.meta.url).pathname,
		],
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const dispatch = stream((context) => {
		const last = context.messages.at(-1);
		if (
			last?.role === "user" &&
			lastText(context) === 'spawn subagent with: "say hello"'
		) {
			return toolCall("subagent", { instructions: "say hello" });
		}
		return response(last?.role === "toolResult" ? lastText(context) : "hello");
	});
	modelRuntime.registerNativeProvider(testProvider(dispatch));
	const name = `pi-subagents.test-provider.${crypto.randomUUID()}`;
	const key = Symbol.for(name);
	const shared = globalThis as typeof globalThis & { [key]?: Provider };
	shared[key] = testProvider(dispatch);
	await mkdir(join(directory, "extensions"));
	await writeFile(
		join(directory, "extensions", "provider.js"),
		`export default function(pi) { pi.registerProvider(globalThis[Symbol.for("${name}")]); }`,
	);
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify(settings.getSettings()),
	);
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		modelRuntime,
		model,
		thinkingLevel: "high",
		resourceLoader: loader,
		settingsManager: settings,
		sessionManager: SessionManager.inMemory(directory),
	});
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await session.bindExtensions({ mode: "print" });
		const events: string[] = [];
		const unsubscribe = session.subscribe((event) => {
			events.push(event.type);
		});
		await session.prompt('spawn subagent with: "say hello"');
		expect(session.getLastAssistantText()).toBe("hello");
		expect(
			events.filter((event) => event === "tool_execution_start"),
		).toHaveLength(1);
		expect(
			events.filter((event) => event === "tool_execution_update"),
		).toHaveLength(0);
		expect(
			events.filter((event) => event === "tool_execution_end"),
		).toHaveLength(1);
		expect(
			session.messages.filter((message) => message.role === "assistant"),
		).toHaveLength(2);
		const result = session.messages.find(
			(message) => message.role === "toolResult",
		);
		expect(result?.role === "toolResult" && result.usage?.totalTokens).toBe(3);
		const tool = session.getToolDefinition("subagent");
		// Renderers use no host context or theme for their empty in-flight display.
		expect(
			tool
				?.renderCall?.({ instructions: "hello" }, {} as never, {} as never)
				.render(80),
		).toEqual([]);
		expect(
			tool
				?.renderResult?.(
					{ content: [], details: {} },
					{ expanded: false, isPartial: true },
					{} as never,
					{} as never,
				)
				.render(80),
		).toEqual([]);
		await session.prompt("/subagents depth 0");
		await session.prompt('spawn subagent with: "say hello"');
		const results = session.messages.filter(
			(message) => message.role === "toolResult",
		);
		expect(results.at(-1)?.isError).toBe(true);
		expect(JSON.stringify(results.at(-1)?.content)).toContain("max depth 0");
		unsubscribe();
	} finally {
		await session.extensionRunner?.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		session.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		delete shared[key];
		await rm(directory, { recursive: true, force: true });
	}
});
