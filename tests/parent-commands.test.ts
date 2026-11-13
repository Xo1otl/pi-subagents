import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Provider } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createSubagentIntegration } from "../agent/index.ts";
import {
	isProcessGroupActive,
	waitForGroupToFinish,
} from "../agent/process-groups.ts";
import { COMMAND_EXIT_TYPE } from "../agent/protocol.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	backgroundJob,
	deferred,
	lastText,
	parentSession,
	response,
	stream,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

type Job = ReturnType<typeof backgroundJob>;

const parents: { session: AgentSession; tree: Subagents }[] = [];
const jobs: Job[] = [];
afterEach(async () => {
	// The root never ends its jobs, so the tests must.
	await Promise.all(jobs.splice(0).map((job) => job.release()));
	for (const { session, tree } of parents.splice(0)) {
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		await tree.dispose();
		session.dispose();
	}
});

/** A root that starts `job` when told to, with the rest of its replies given. */
async function setup(
	reply: (text: string, signal?: AbortSignal) => string | Promise<string>,
	{
		mode,
		extensions = [],
	}: { mode?: ExtensionContext["mode"]; extensions?: ExtensionFactory[] } = {},
) {
	let tree: Subagents | undefined;
	let job: Job | undefined;
	const dispatch: Provider["streamSimple"] = stream(
		async (context, options) => {
			const text = lastText(context);
			if (text === "start job") {
				if (!job) throw new Error("Missing job");
				return toolCall("bash", { command: job.command });
			}
			return response(
				context.messages.at(-1)?.role === "toolResult"
					? "job started"
					: await reply(text, options?.signal),
			);
		},
	);
	const session = await parentSession(
		dispatch,
		[
			(pi) =>
				pi.registerTool(
					createSubagentIntegration(pi, {
						bind(runtime) {
							tree = runtime;
						},
						dispose() {},
					}),
				),
			...extensions,
		],
		undefined,
		undefined,
		mode,
	);
	if (!tree) throw new Error("Missing root runtime");
	parents.push({ session, tree });
	job = backgroundJob(session.sessionManager.getCwd(), "parent");
	jobs.push(job);
	return { session, tree, job };
}

function exits(session: AgentSession) {
	return session.messages.filter(
		(message) =>
			message.role === "custom" && message.customType === COMMAND_EXIT_TYPE,
	);
}

async function group(job: Job): Promise<number> {
	return Number((await readFile(job.group, "utf8")).trim());
}

const checked = (text: string) =>
	text.startsWith("Process group ") ? "checked after exit" : text;

test("a parent's background job resumes it when idle, and private user commands stay untracked", async () => {
	const { session, tree, job } = await setup(checked);
	const userBash = (excludeFromContext: boolean) =>
		session.extensionRunner.emitUserBash({
			type: "user_bash",
			command: "true",
			excludeFromContext,
			cwd: session.sessionManager.getCwd(),
		});
	expect((await userBash(false))?.operations).toBeDefined();
	expect(await userBash(true)).toBeUndefined();

	await session.prompt("start job");
	expect(session.getLastAssistantText()).toBe("job started");
	await session.prompt("still available");
	expect(exits(session)).toHaveLength(0);
	await job.release();
	await until(
		() =>
			session.isIdle && session.getLastAssistantText() === "checked after exit",
	);
	await tree.settled(ROOT);
	expect(existsSync(job.finished)).toBe(true);
	expect(exits(session)).toHaveLength(1);
	expect(exits(session)[0]).toMatchObject({
		details: { pgid: await group(job), exitCode: null },
	});
});

test("a job exit waits for a busy parent, survives its interrupt, and does not restart the turn", async () => {
	const busy = deferred();
	let running = false;
	let notified = 0;
	const { session, tree, job } = await setup(async (text, signal) => {
		if (text === "busy prompt") {
			running = true;
			await Promise.race([busy.promise, waiting(signal)]);
		}
		if (text.startsWith("Process group ")) notified++;
		return checked(text);
	});
	try {
		await session.prompt("start job");
		const prompt = session.prompt("busy prompt");
		await until(() => running);
		await job.release();
		await waitForGroupToFinish(await group(job));
		await tree.settled(ROOT);
		// Held by the integration, so an interrupt clearing pi's queue cannot drop it.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(exits(session)).toHaveLength(0);
		session.clearQueue();
		await session.abort();
		await prompt;
		await session.waitForIdle();
		expect(exits(session)).toHaveLength(1);
		expect(notified).toBe(0);
	} finally {
		busy.resolve();
	}
});

test("a one-shot parent waits for its background job and answers the exit", async () => {
	const { session, job } = await setup(checked, { mode: "print" });
	let finished = false;
	const prompt = session.prompt("start job").then(() => {
		finished = true;
	});
	await until(() => session.getLastAssistantText() === "job started");
	await Bun.sleep(50);
	expect(finished).toBe(false);
	await job.release();
	await prompt;
	expect(exits(session)).toHaveLength(1);
	expect(session.getLastAssistantText()).toBe("checked after exit");
});

test("shutdown stops watching a parent's job without ending it", async () => {
	const { session, tree, job } = await setup(checked);
	await session.prompt("start job");
	const pgid = await group(job);
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	expect(tree.closed).toBe(true);
	expect(await isProcessGroupActive(pgid)).toBe(true);
	await job.release();
	await waitForGroupToFinish(pgid);
	expect(existsSync(job.finished)).toBe(true);
	expect(exits(session)).toHaveLength(0);
});

test("a configured bash override in the parent is neither replaced nor tracked", async () => {
	const remote: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "bash",
			label: "Remote bash",
			description: "Remote execution",
			parameters: { type: "object", properties: {} },
			promptGuidelines: ["REMOTE_BASH_MARKER"],
			async execute() {
				return {
					content: [{ type: "text", text: "remote result" }],
					details: undefined,
				};
			},
		});
	};
	// Loaded after the integration, whose own registration would otherwise win.
	const { session, job } = await setup(checked, { extensions: [remote] });
	expect(session.getToolDefinition("bash")?.promptGuidelines).toEqual([
		"REMOTE_BASH_MARKER",
	]);
	await session.prompt("start job");
	expect(existsSync(job.group)).toBe(false);
	expect(
		await session.extensionRunner.emitUserBash({
			type: "user_bash",
			command: "true",
			excludeFromContext: false,
			cwd: session.sessionManager.getCwd(),
		}),
	).toBeUndefined();
});
