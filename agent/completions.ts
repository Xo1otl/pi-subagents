import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../runtime/errors.ts";
import type { SubagentResult } from "../runtime/index.ts";
import {
	SUBAGENT_RESULT_TYPE,
	type SubagentCompletionMessage,
} from "./protocol.ts";

const LIMITS = {
	maxBytes: DEFAULT_MAX_BYTES - 1024,
	maxLines: DEFAULT_MAX_LINES - 4,
};

async function boundedOutput(
	output: string,
): Promise<{ text: string; fullOutputPath?: string }> {
	const truncated = truncateHead(output, LIMITS);
	if (!truncated.truncated) return { text: truncated.content };
	let directory: string | undefined;
	try {
		directory = await mkdtemp(join(tmpdir(), "pi-subagents-output-"));
		const fullOutputPath = join(directory, "output.txt");
		await writeFile(fullOutputPath, output, "utf8");
		return {
			text: `${truncated.content}\n[Output truncated. Full output saved to: ${fullOutputPath}]`,
			fullOutputPath,
		};
	} catch (error) {
		if (directory)
			await rm(directory, { recursive: true, force: true }).catch(() => {});
		const reason = truncateHead(errorMessage(error), {
			maxBytes: 256,
			maxLines: 1,
		}).content;
		return {
			text: `${truncated.content}\n[Could not save full output: ${reason}]`,
		};
	}
}

export async function subagentCompletionMessage(
	result: SubagentResult,
): Promise<SubagentCompletionMessage> {
	const { text, fullOutputPath } = await boundedOutput(result.output);
	const { id, status, error, usage } = result;
	return {
		customType: SUBAGENT_RESULT_TYPE,
		content: [
			{ type: "text", text: `Subagent ${id} ${status}.` },
			{ type: "text", text },
		],
		display: true,
		details: { id, status, error, usage, fullOutputPath },
	};
}

export async function discardSubagentCompletion(
	message: SubagentCompletionMessage,
): Promise<void> {
	const { fullOutputPath } = message.details;
	if (fullOutputPath)
		await rm(dirname(fullOutputPath), { recursive: true, force: true });
}
