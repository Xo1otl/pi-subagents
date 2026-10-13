import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	type MarkdownTheme,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Subagent, SubagentToolExecution } from "../runtime/index.ts";
import { plain, singleLine } from "./text.ts";

export type ChatTheme = Pick<Theme, "fg">;

export interface TranscriptRow {
	text: string;
	blockId: string;
	offset: number;
	/** Only the disclosure header is clickable, leaving logs selectable. */
	toolId?: string;
}

export interface TranscriptLayout {
	rows: readonly TranscriptRow[];
}

export interface TranscriptPreferences {
	expandTools: boolean;
	showThinking: boolean;
	/** Per-call overrides survive streaming updates and agent switches. */
	toolExpanded: ReadonlyMap<string, boolean>;
}

interface Block {
	id: string;
	label: string;
	text: string;
	kind: "message" | "thinking" | "tool";
	args?: unknown;
	status?: SubagentToolExecution["status"] | "aborted";
	nested?: boolean;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "image") return `[image: ${part.mimeType}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function transcriptBlocks(node: Subagent): Block[] {
	const messages =
		node.session?.sessionManager
			.getBranch()
			.flatMap((entry): AgentMessage[] => {
				if (entry.type === "message") return [entry.message];
				if (entry.type === "custom_message")
					return [
						{
							role: "custom",
							...entry,
							timestamp: Date.parse(entry.timestamp),
						},
					];
				if (entry.type === "compaction" || entry.type === "branch_summary")
					return [
						{
							role:
								entry.type === "compaction"
									? "compactionSummary"
									: "branchSummary",
							summary: entry.summary,
							tokensBefore:
								entry.type === "compaction" ? entry.tokensBefore : 0,
							fromId: entry.type === "branch_summary" ? entry.fromId : null,
							timestamp: Date.parse(entry.timestamp),
						},
					];
				return [];
			}) ?? [];
	const streaming = node.session?.state.streamingMessage;
	if (
		streaming &&
		!messages.some(
			(message) =>
				message.role === "assistant" &&
				message.timestamp === streaming.timestamp,
		)
	)
		messages.push(streaming);

	const results = new Map(
		messages.flatMap((message) =>
			message.role === "toolResult"
				? [[message.toolCallId, message] as const]
				: [],
		),
	);
	const blocks: Block[] = [];
	const calls = new Set<string>();
	const occurrences = new Map<string, number>();

	function addTool(
		id: string,
		name: string,
		args?: unknown,
		nested = false,
	): void {
		if (calls.has(id)) return;
		calls.add(id);
		const result = results.get(id);
		const live = node.liveTools.get(id);
		blocks.push({
			id: `tool:${id}`,
			kind: "tool",
			label: name,
			args: args ?? live?.args,
			text: contentText(result?.content ?? live?.result?.content),
			status: result
				? result.isError
					? "error"
					: "done"
				: (live?.status ?? (node.status === "running" ? "running" : "aborted")),
			nested,
		});
		for (const child of node.liveTools.values())
			if (child.parentToolCallId === id)
				addTool(child.toolCallId, child.toolName, child.args, true);
	}

	for (const message of messages) {
		if (
			message.role === "system" ||
			(message.role === "custom" && !message.display)
		)
			continue;
		// A partial and finalized assistant message share this key, even though
		// the final session entry receives a new ID. Disambiguate same-ms messages.
		const key = `${message.role}:${message.timestamp}`;
		const occurrence = occurrences.get(key) ?? 0;
		occurrences.set(key, occurrence + 1);
		const id = `${key}:${occurrence}`;
		if (message.role === "assistant") {
			message.content.forEach((part, index) => {
				if (part.type === "toolCall")
					addTool(part.id, part.name, part.arguments);
				else if (part.type === "text" || part.type === "thinking")
					blocks.push({
						id: `${id}:${index}`,
						kind: part.type === "thinking" ? "thinking" : "message",
						label: part.type === "thinking" ? "thinking" : "assistant",
						text: part.type === "thinking" ? part.thinking : part.text,
					});
			});
		} else if (message.role === "toolResult") {
			// Old or extension-injected transcripts can contain orphan results.
			addTool(message.toolCallId, message.toolName);
		} else if (message.role === "bashExecution") {
			blocks.push({
				id,
				kind: "tool",
				label: "bash",
				args: { command: message.command },
				text: message.output,
				status: message.cancelled
					? "aborted"
					: message.exitCode === 0
						? "done"
						: "error",
			});
		} else {
			blocks.push({
				id,
				kind: "message",
				label: message.role === "custom" ? message.customType : message.role,
				text:
					"content" in message ? contentText(message.content) : message.summary,
			});
		}
	}
	// Execution events can precede transcript persistence, including nested tools
	// that never have their own transcript message.
	for (const live of node.liveTools.values())
		addTool(
			live.toolCallId,
			live.toolName,
			live.args,
			Boolean(live.parentToolCallId),
		);
	return blocks;
}

function markdownTheme(theme: ChatTheme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
		italic: (text) => `\x1b[3m${text}\x1b[23m`,
		strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
		underline: (text) => `\x1b[4m${text}\x1b[24m`,
	};
}

function argumentPreview(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	for (const key of ["command", "path", "instructions", "pattern"] as const)
		if (key in args)
			return String((args as Record<string, unknown>)[key]).replace(
				/\s+/g,
				" ",
			);
	return "";
}

function renderBlock(
	block: Block,
	width: number,
	theme: ChatTheme,
	expanded: boolean,
): string[] {
	const text = plain(block.text);
	if (block.kind !== "tool") {
		const header = theme.fg(
			block.label === "user" ? "accent" : "muted",
			singleLine(block.label),
		);
		const body =
			block.label === "user"
				? new Text(text, 0, 0)
				: new Markdown(text, 0, 0, markdownTheme(theme));
		return [truncateToWidth(header, width), ...body.render(width)];
	}
	const color =
		block.status === "error" || block.status === "aborted"
			? "error"
			: block.status === "running"
				? "warning"
				: "success";
	const header = `${block.nested ? "  " : ""}${expanded ? "▾" : "▸"} ${singleLine(block.label)} [${block.status}] ${singleLine(argumentPreview(block.args))}`;
	const lines = [truncateToWidth(theme.fg(color, header), width)];
	if (expanded && block.args !== undefined)
		lines.push(
			...new Text(
				theme.fg("dim", plain(JSON.stringify(block.args, null, 2) ?? "")),
				0,
				0,
			).render(width),
		);
	const output = text ? new Text(text, 0, 0).render(width) : [];
	const limit = block.status === "running" ? 3 : 4;
	const preview = expanded ? output : output.slice(-limit);
	if (!expanded && output.length > preview.length)
		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					`… ${output.length - preview.length} more lines · expand for full output`,
				),
				width,
			),
		);
	lines.push(...preview.map((line) => theme.fg("toolOutput", line)));
	if (!output.length)
		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					block.status === "running" ? "Running…" : "(no output)",
				),
				width,
			),
		);
	return lines;
}

/** Cache each block independently so a live log does not re-render old Markdown. */
export function createTranscriptRenderer(theme: ChatTheme) {
	let cache = new Map<
		string,
		{ block: Block; width: number; expanded: boolean; lines: string[] }
	>();
	return {
		render(
			node: Subagent,
			width: number,
			preferences: TranscriptPreferences,
		): TranscriptLayout {
			const rows: TranscriptRow[] = [];
			const next: typeof cache = new Map();
			for (const block of transcriptBlocks(node)) {
				if (!block.text.trim() && block.kind !== "tool") continue;
				if (block.kind === "thinking" && !preferences.showThinking) continue;
				const expanded =
					preferences.toolExpanded.get(block.id) ?? preferences.expandTools;
				const cached = cache.get(block.id);
				const lines =
					cached &&
					cached.width === width &&
					cached.expanded === expanded &&
					cached.block.text === block.text &&
					cached.block.label === block.label &&
					cached.block.status === block.status &&
					cached.block.args === block.args &&
					cached.block.nested === block.nested
						? cached.lines
						: renderBlock(block, width, theme, expanded);
				next.set(block.id, { block, width, expanded, lines });
				if (rows.length) rows.push({ text: "", blockId: block.id, offset: -1 });
				lines.forEach((text, offset) => {
					rows.push({
						text: truncateToWidth(text, width, ""),
						blockId: block.id,
						offset,
						toolId:
							block.kind === "tool" && offset === 0 ? block.id : undefined,
					});
				});
			}
			cache = next;
			if (!rows.length)
				rows.push({
					text: theme.fg(
						"dim",
						node.status === "running" ? "(starting…)" : "(no messages)",
					),
					blockId: "empty",
					offset: 0,
				});
			return { rows };
		},
		invalidate() {
			cache.clear();
		},
	};
}
