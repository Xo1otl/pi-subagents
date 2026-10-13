import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Subagent, SubagentToolExecution } from "../runtime/index.ts";
import {
	createTranscriptRenderer,
	type TranscriptPreferences,
} from "../ui/transcript.ts";
import { model, response, toolCall } from "./fixtures.ts";

const theme = { fg: (_color: string, text: string) => text };
function node(
	messages: AgentMessage[] = [],
	streamingMessage?: AgentMessage,
): Subagent & { liveTools: Map<string, SubagentToolExecution> } {
	return {
		id: "1",
		parentId: "root",
		depth: 1,
		instructions: "task",
		context: { cwd: "/unused", model, projectTrusted: false },
		status: "running",
		cancelled: false,
		liveTools: new Map(),
		queuedInput: [],
		session: {
			sessionManager: {
				getBranch: () =>
					messages.map((message, index) => ({
						type: "message",
						id: String(index),
						message,
					})),
			},
			state: { streamingMessage },
		} as unknown as AgentSession,
	};
}
function preferences(): TranscriptPreferences & {
	toolExpanded: Map<string, boolean>;
} {
	return { expandTools: false, showThinking: false, toolExpanded: new Map() };
}
function text(
	renderer: ReturnType<typeof createTranscriptRenderer>,
	agent: Subagent,
	prefs = preferences(),
	width = 80,
) {
	return renderer
		.render(agent, width, prefs)
		.rows.map((row) => stripTerminalSequences(row.text))
		.join("\n");
}

test("tool calls and results form one independently collapsible block, with thinking separate", () => {
	const call = toolCall("bash", { command: "npm test" });
	call.content.unshift({ type: "thinking", thinking: "PRIVATE_THINKING" });
	call.content.push({ type: "text", text: "**Assistant explanation**" });
	const id = call.content.find((part) => part.type === "toolCall")?.id;
	if (!id) throw new Error("Missing call");
	const agent = node([
		call,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			timestamp: 123,
			content: [
				{
					type: "text",
					text: Array.from({ length: 40 }, (_, i) => `log ${i}`).join("\n"),
				},
			],
			isError: false,
		},
	]);
	const renderer = createTranscriptRenderer(theme);
	const prefs = preferences();
	expect(text(renderer, agent, prefs)).toContain("▸ bash [done] npm test");
	expect(text(renderer, agent, prefs)).toContain("36 more lines");
	expect(text(renderer, agent, prefs)).toContain("log 39");
	expect(text(renderer, agent, prefs)).not.toContain("log 0");
	expect(text(renderer, agent, prefs)).not.toContain("PRIVATE_THINKING");
	expect(text(renderer, agent, prefs)).toContain("Assistant explanation");
	expect(text(renderer, agent, prefs)).not.toContain("**Assistant");
	prefs.toolExpanded.set(`tool:${id}`, true);
	expect(text(renderer, agent, prefs)).toContain("▾ bash [done]");
	expect(text(renderer, agent, prefs)).toContain("log 0");
	expect(text(renderer, agent, prefs)).toContain('"command": "npm test"');
	expect(text(renderer, agent, prefs)).not.toContain("PRIVATE_THINKING");
	prefs.showThinking = true;
	expect(text(renderer, agent, prefs)).toContain("PRIVATE_THINKING");
	expect(
		renderer.render(agent, 80, prefs).rows.filter((row) => row.toolId),
	).toHaveLength(1);
});

test("live execution snapshots replace previews and terminal results take precedence without duplication", () => {
	const call = toolCall("bash", { command: "slow command" });
	const part = call.content[0];
	if (part?.type !== "toolCall") throw new Error("Missing call");
	const messages: AgentMessage[] = [];
	const agent = node(messages, call);
	const renderer = createTranscriptRenderer(theme);
	agent.liveTools.set(part.id, {
		toolCallId: part.id,
		toolName: "bash",
		args: part.arguments,
		status: "running",
		result: {
			content: [{ type: "text", text: "old snapshot" }],
			details: undefined,
		},
	});
	expect(text(renderer, agent)).toContain("old snapshot");
	const live = agent.liveTools.get(part.id);
	if (!live) throw new Error("Missing live tool");
	live.result = {
		content: [{ type: "text", text: "new snapshot" }],
		details: undefined,
	};
	expect(text(renderer, agent)).not.toContain("old snapshot");
	expect(text(renderer, agent)).toContain("new snapshot");
	const before = renderer.render(agent, 80, preferences()).rows[0]?.blockId;
	messages.push(call, {
		role: "toolResult",
		toolCallId: part.id,
		toolName: "bash",
		timestamp: 124,
		content: [{ type: "text", text: "authoritative final" }],
		isError: true,
	});
	expect(text(renderer, agent)).toContain("bash [error]");
	expect(text(renderer, agent)).toContain("authoritative final");
	expect(text(renderer, agent)).not.toContain("new snapshot");
	expect(renderer.render(agent, 80, preferences()).rows[0]?.blockId).toBe(
		before,
	);
	expect(
		renderer.render(agent, 80, preferences()).rows.filter((row) => row.toolId),
	).toHaveLength(1);
});

test("nested tool output is streamed under its parent and hidden custom messages stay hidden", () => {
	const agent = node([
		{
			role: "custom",
			customType: "private",
			display: false,
			timestamp: 0,
			content: "HIDDEN_CUSTOM",
		},
	]);
	agent.liveTools.set("outer", {
		toolCallId: "outer",
		toolName: "codemode",
		args: {},
		status: "running",
	});
	agent.liveTools.set("outer/1", {
		toolCallId: "outer/1",
		toolName: "bash",
		args: { command: "echo nested" },
		parentToolCallId: "outer",
		status: "running",
		result: {
			content: [{ type: "text", text: "nested live output" }],
			details: undefined,
		},
	});
	const output = text(createTranscriptRenderer(theme), agent);
	expect(output.indexOf("codemode")).toBeLessThan(output.indexOf("bash"));
	expect(output).toContain("  ▸ bash [running]");
	expect(output).toContain("nested live output");
	expect(output).not.toContain("HIDDEN_CUSTOM");
});

test("sanitizes untrusted controls, respects terminal columns and invalidates cached theme colors", () => {
	let color = "A";
	const renderer = createTranscriptRenderer({
		fg: (_name, value) => `${color}${value}`,
	});
	const agent = node([
		{
			role: "custom",
			customType: "untrusted\nlabel",
			display: true,
			timestamp: 0,
			content: "note",
		},
		response(
			"# 日本語🙂\n\n\u001b]2;INJECTED_TITLE\u0007**bold**\n```sh\necho test\n```",
		),
	]);
	expect(text(renderer, agent)).not.toContain("INJECTED_TITLE");
	expect(text(renderer, agent)).toContain("Aassistant");
	color = "B";
	renderer.invalidate();
	expect(text(renderer, agent)).toContain("Bassistant");
	const normal = createTranscriptRenderer(theme);
	for (const width of [1, 2, 3, 10, 40, 80])
		for (const row of normal.render(agent, width, preferences()).rows) {
			expect(visibleWidth(row.text)).toBeLessThanOrEqual(width);
			expect(row.text).not.toContain("\n");
		}
});
