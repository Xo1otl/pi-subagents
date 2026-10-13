import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { SubagentResult } from "../runtime/index.ts";
import {
	SUBAGENT_RESULT_TYPE,
	type SubagentCompletionDetails,
	type SubagentCompletionMessage,
} from "./protocol.ts";

// Reserve room for attribution and the full-output notice within Pi's limits.
const LIMITS = {
	maxBytes: DEFAULT_MAX_BYTES - 1024,
	maxLines: DEFAULT_MAX_LINES - 4,
};

/** Bound model context without mixing terminal UI instructions into it. */
async function boundedOutput(
	output: string,
): Promise<{ text: string; fullOutputPath?: string }> {
	const truncated = truncateHead(output, LIMITS);
	if (!truncated.truncated) return { text: truncated.content };
	try {
		const directory = await mkdtemp(join(tmpdir(), "pi-subagents-output-"));
		const fullOutputPath = join(directory, "output.txt");
		try {
			await writeFile(fullOutputPath, output, "utf8");
		} catch (error) {
			await rm(directory, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
		return {
			text: `${truncated.content}\n[Output truncated. Full output saved to: ${fullOutputPath}]`,
			fullOutputPath,
		};
	} catch (error) {
		// A failed temp-file write must not lose completion or usage accounting.
		const reason = error instanceof Error ? error.message : String(error);
		return {
			text: `${truncated.content}\n[Could not save full output: ${truncateHead(reason, { maxBytes: 256, maxLines: 1 }).content}]`,
		};
	}
}

/** A completion is context, not another tool result (and never contains UI ANSI). */
export async function subagentCompletionMessage(
	result: SubagentResult,
): Promise<SubagentCompletionMessage> {
	const { text, fullOutputPath } = await boundedOutput(result.output);
	const details: SubagentCompletionDetails = {
		id: result.id,
		status: result.status,
		error: result.error,
		usage: result.usage,
	};
	if (fullOutputPath) details.fullOutputPath = fullOutputPath;
	return {
		customType: SUBAGENT_RESULT_TYPE,
		content: [
			{ type: "text", text: `Subagent ${result.id} ${result.status}.` },
			{ type: "text", text },
		],
		display: true,
		details,
	};
}

/** Formatting may finish after the originating session has been invalidated. */
export async function discardSubagentCompletion(
	message: SubagentCompletionMessage,
): Promise<void> {
	if (message.details.fullOutputPath) {
		await rm(dirname(message.details.fullOutputPath), {
			recursive: true,
			force: true,
		});
	}
}
