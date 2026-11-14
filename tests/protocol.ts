import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	COMMAND_EXIT_TYPE,
	COMMAND_UNKNOWN_TYPE,
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_RESUME_TYPE,
	type SubagentCompletionDetails,
} from "../agent/protocol.ts";

type CustomMessage = Extract<AgentMessage, { role: "custom" }>;
const prefix = "pi-subagents-test-event:";
const types = new Set([
	COMMAND_EXIT_TYPE,
	COMMAND_UNKNOWN_TYPE,
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_RESUME_TYPE,
]);

/** Pi converts custom messages to user text before calling a provider. Preserve
 * their protocol metadata for deterministic test providers, not their wording.
 * This hook changes request context only; recorded messages and UI stay real.
 */
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

export function lastCustomMessage(
	context: TranscriptContext,
	customType: string,
): CustomMessage | undefined {
	const last = context.messages.at(-1);
	if (last?.role !== "user") return undefined;
	const text = contentText(last.content);
	if (!text.startsWith(prefix)) return undefined;
	const message = JSON.parse(text.slice(prefix.length)) as CustomMessage;
	return message.customType === customType ? message : undefined;
}

/** A completion's body follows its attribution block, independently of the
 * heading's wording or how the model-facing text joins the blocks.
 */
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
