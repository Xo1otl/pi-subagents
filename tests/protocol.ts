import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	COMMAND_EXIT_TYPE,
	COMMAND_UNKNOWN_TYPE,
	SUBAGENT_REMINDER_TYPE,
	SUBAGENT_RESULT_TYPE,
	type SubagentCompletionDetails,
} from "../agent/protocol.ts";

type CustomMessage = Extract<AgentMessage, { role: "custom" }>;
const prefix = "pi-subagents-test-event:";
export const PROTOCOL_TYPES: string[] = [
	COMMAND_EXIT_TYPE,
	COMMAND_UNKNOWN_TYPE,
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_REMINDER_TYPE,
];
const types = new Set(PROTOCOL_TYPES);

export function protocolMessages(
	messages: readonly AgentMessage[],
): AgentMessage[] {
	return messages.map((message) =>
		message.role === "custom" && types.has(message.customType)
			? { ...message, content: prefix + JSON.stringify(message) }
			: message,
	);
}

export default function protocolFixture(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({ messages: protocolMessages(event.messages) }));
}

type ProviderMessage = TranscriptContext["messages"][number];

function decode(
	message: ProviderMessage | undefined,
): CustomMessage | undefined {
	if (message?.role !== "user") return undefined;
	const text = contentText(message.content);
	if (!text.startsWith(prefix)) return undefined;
	return JSON.parse(text.slice(prefix.length)) as CustomMessage;
}

export function isProtocolMessage(message: ProviderMessage): boolean {
	return decode(message) !== undefined;
}

export function lastCustomMessage(
	context: TranscriptContext,
	customType: string,
): CustomMessage | undefined {
	const message = decode(context.messages.at(-1));
	return message?.customType === customType ? message : undefined;
}

export function hasCustomMessage(
	context: TranscriptContext,
	customType: string,
): boolean {
	return context.messages.some(
		(message) => decode(message)?.customType === customType,
	);
}

export function completionOutput({
	content,
}: Pick<CustomMessage, "content">): string {
	return contentText(typeof content === "string" ? content : content.slice(1));
}

export function lastCompletion(context: TranscriptContext) {
	const message = lastCustomMessage(context, SUBAGENT_RESULT_TYPE);
	if (!message) return undefined;
	return {
		...(message.details as SubagentCompletionDetails),
		output: completionOutput(message),
	};
}
