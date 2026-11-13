import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	COMMAND_EXIT_TYPE,
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_RESUME_TYPE,
} from "../agent/protocol.ts";
import { lastCustomMessage, protocolMessages } from "./protocol.ts";

test.each([COMMAND_EXIT_TYPE, SUBAGENT_RESULT_TYPE, SUBAGENT_RESUME_TYPE])(
	"test providers route %s by protocol type, regardless of wording",
	(customType) => {
		for (const content of ["", "Arbitrary replacement wording."]) {
			const original: AgentMessage = {
				role: "custom",
				customType,
				content,
				display: true,
				timestamp: 0,
			};
			const encoded = protocolMessages([original])[0];
			if (encoded?.role !== "custom") throw new Error("Missing custom message");
			const context = normalizeContext({
				messages: [
					{
						role: "user",
						content: encoded.content,
						timestamp: encoded.timestamp,
					},
				],
			});
			expect(lastCustomMessage(context, customType)).toMatchObject({
				customType,
				content,
			});
			expect(lastCustomMessage(context, "unrelated-event")).toBeUndefined();
			expect(original.content).toBe(content);
		}
	},
);

test("protocol fixtures leave ordinary user and extension messages unchanged", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "ordinary input", timestamp: 0 },
		{
			role: "custom",
			customType: "another-extension",
			content: "ordinary context",
			display: false,
			timestamp: 0,
		},
	];
	expect(protocolMessages(messages)).toEqual(messages);
});
