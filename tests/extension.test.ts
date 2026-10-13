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
	until,
} from "./fixtures.ts";

test("loads as a real pi extension and delivers completion separately from the running receipt", async () => {
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
		const text = lastText(context);
		if (last?.role === "user" && text === 'spawn subagent with: "say hello"')
			return toolCall("subagent", { instructions: "say hello" });
		const completion =
			/^Subagent [\d.]+ (?:done|error|aborted)\.\n([\s\S]*)$/.exec(text);
		return response(
			completion?.[1] ?? (last?.role === "toolResult" ? "Delegated" : "hello"),
		);
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
		await until(
			() =>
				session.isIdle &&
				session.messages.some(
					(message) =>
						message.role === "custom" &&
						message.customType === "subagent-result",
				),
		);
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
		).toHaveLength(3);
		const result = session.messages.find(
			(message) => message.role === "toolResult",
		);
		expect(result?.role === "toolResult" && result.details).toEqual({
			id: "1",
			status: "running",
		});
		expect(result?.role === "toolResult" && result.usage).toBeUndefined();
		expect(session.getSessionStats().tokens.total).toBe(12);
		expect(
			session.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom" && entry.customType === "subagent-usage",
				),
		).toHaveLength(1);
		const tool = session.getToolDefinition("subagent");
		expect(tool?.renderCall).toBeDefined();
		expect(tool?.renderResult).toBeDefined();
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
