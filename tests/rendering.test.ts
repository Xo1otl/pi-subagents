import { expect, test } from "bun:test";
import type { ExtensionFactory, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import extension from "../index.ts";
import { parentSession } from "./fixtures.ts";

test.each([false, true])(
	"other extensions can wrap subagent renderers regardless of load order (%s)",
	async (wrapperFirst) => {
		let visits = 0;
		const wrapper: ExtensionFactory = (pi) => {
			pi.registerToolRenderer((name, next) => {
				const base = next();
				if (name !== "subagent") return base;
				visits++;
				if (!base?.renderCall || !base.renderResult)
					throw new Error("Missing subagent defaults");
				const { renderCall, renderResult } = base;
				return {
					...base,
					renderCall: (args, theme, ctx) =>
						new Text(
							`Wrapped ${renderCall(args, theme, ctx).render(120).join("\n")}`,
							0,
							0,
						),
					renderResult: (result, options, theme, ctx) =>
						new Text(
							`Wrapped ${renderResult(result, options, theme, ctx).render(120).join("\n")}`,
							0,
							0,
						),
				};
			});
		};
		const session = await parentSession({
			extensions: wrapperFirst ? [wrapper, extension] : [extension, wrapper],
		});
		const tool = session.getToolDefinition("subagent");
		const renderers = session.extensionRunner.resolveToolRenderers(
			"subagent",
			() => tool,
		);
		const theme = { fg: (_color: string, text: string) => text } as Theme;
		const call = renderers
			?.renderCall?.({ instructions: "hello" }, theme, {} as never)
			.render(120)
			.join("\n");
		expect(call).toStartWith("Wrapped ");
		expect(call).toContain("hello");
		const result = renderers
			?.renderResult?.(
				{
					content: [{ type: "text", text: "task output" }],
					details: { id: "1" },
				},
				{ expanded: false, isPartial: false },
				theme,
				{} as never,
			)
			.render(120)
			.join("\n");
		expect(result).toStartWith("Wrapped task output");
		expect(result).toContain("/subagents 1");
		expect(visits).toBe(1);
		const completionRenderer =
			session.extensionRunner.getMessageRenderer("subagent-result");
		expect(completionRenderer).toBeDefined();
		const message = {
			role: "custom" as const,
			customType: "subagent-result",
			display: true,
			timestamp: 0,
			details: { id: "1", status: "done" },
			content: Array.from(
				{ length: 20 },
				(_, i) => `completion line ${i}`,
			).join("\n"),
		};
		const collapsed = completionRenderer?.(
			message,
			{ expanded: false, outputPad: 0 },
			theme,
		)
			?.render(120)
			.join("\n");
		expect(collapsed).toContain("completion line 0");
		expect(collapsed).not.toContain("completion line 19");
		expect(
			completionRenderer?.(message, { expanded: true, outputPad: 0 }, theme)
				?.render(120)
				.join("\n"),
		).toContain("completion line 19");
	},
);
