import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	isToolCallEventType,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { errorMessage, hasErrorCode } from "../runtime/errors.ts";
import type { Leftover, SessionOwner } from "../runtime/index.ts";
import { servesSession } from "./context.ts";
import {
	isProcessGroupActive,
	UNKNOWN_STATUS_REPORT_MS,
	waitForGroupToFinish,
} from "./process-groups.ts";
import {
	COMMAND_EXIT_TYPE,
	COMMAND_UNKNOWN_TYPE,
	type CommandExitMessage,
	type CommandJob,
	type CommandMessage,
	type CommandUnknownMessage,
} from "./protocol.ts";
import { foregroundSleepSeconds, SLEEP_LIMIT_SECONDS } from "./sleep.ts";

type CommandListener = (
	message: CommandMessage,
	signal: AbortSignal,
) => void | Promise<void>;

export interface CommandHost {
	readonly ownsJobs: boolean;
	track(work: Promise<void>, ctx: ExtensionContext, leftover?: Leftover): void;
	listener(ctx: ExtensionContext): CommandListener | undefined;
}

export interface CommandTracking {
	stop(): void;
}

interface TrackedSession {
	readonly ctx: ExtensionContext;
	readonly shell: BashOperations;
	readonly prefix: string | undefined;
}

function commandPreview(command: string): string {
	const lines = command.split("\n").filter((line) => line.trim());
	const first = [...(lines[0]?.trim() ?? "")];
	const preview = first.slice(0, 200).join("");
	return first.length > 200 || lines.length > 1 ? `${preview} …` : preview;
}

function commandExit(job: CommandJob): CommandExitMessage {
	return {
		customType: COMMAND_EXIT_TYPE,
		content: `PGID ${job.pgid} exited: ${commandPreview(job.command)}`,
		display: true,
		details: { ...job, exitCode: null },
	};
}

function commandUnknown(
	job: CommandJob,
	error: unknown,
): CommandUnknownMessage {
	const reason = errorMessage(error).replace(/\s+/g, " ").trim();
	const seconds = UNKNOWN_STATUS_REPORT_MS / 1000;
	return {
		customType: COMMAND_UNKNOWN_TYPE,
		content: `PGID ${job.pgid} status unknown for ${seconds}s (${commandPreview(reason)}); still tracked: ${commandPreview(job.command)}`,
		display: true,
		details: { ...job, error: reason },
	};
}

async function recordedGroup(path: string): Promise<number | undefined> {
	let pid: string;
	try {
		pid = await readFile(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	const pgid = Number(pid.trim());
	if (!/^\d+\s*$/.test(pid) || !Number.isSafeInteger(pgid) || pgid <= 1)
		throw new Error(`Invalid command process group: ${pid}`);
	return pgid;
}

export function trackCommands(
	pi: ExtensionAPI,
	host: CommandHost,
	processGroups = {
		isActive: isProcessGroupActive,
		waitForExit: waitForGroupToFinish,
	},
): CommandTracking {
	const groups = new Map<number, ExtensionContext>();
	let scope = new AbortController();
	let session: TrackedSession | undefined;
	let installed = false;

	function end(pgid: number, ctx: ExtensionContext): void {
		if (!host.ownsJobs) return;
		try {
			process.kill(-pgid, "SIGKILL");
		} catch (error) {
			if (!hasErrorCode(error, "ESRCH")) host.track(Promise.reject(error), ctx);
		}
	}

	function stop(): void {
		scope.abort();
		scope = new AbortController();
		const running = [...groups];
		groups.clear();
		for (const [pgid, ctx] of running) end(pgid, ctx);
	}

	function watch(
		job: CommandJob,
		ctx: ExtensionContext,
		notify: CommandListener,
	): void {
		const { pgid } = job;
		const stopped = new AbortController();
		const signal = AbortSignal.any([scope.signal, stopped.signal]);
		groups.set(pgid, ctx);
		const follow = async () => {
			try {
				await processGroups.waitForExit(pgid, {
					signal,
					onUnknown: (error) => notify(commandUnknown(job, error), signal),
				});
				if (signal.aborted) return;
				groups.delete(pgid);
				await notify(commandExit(job), signal);
			} catch (error) {
				if (signal.aborted) return;
				if (groups.delete(pgid)) end(pgid, ctx);
				throw error;
			}
		};
		host.track(follow(), ctx, {
			label: `PGID ${pgid}: ${commandPreview(job.command)}`,
			running: () => groups.has(pgid),
			detach() {
				stopped.abort();
				groups.delete(pgid);
			},
		});
	}

	async function record(
		from: TrackedSession,
		path: string,
		command: string,
		cwd: string,
		aborted: boolean,
	): Promise<number | undefined> {
		const pgid = await recordedGroup(path);
		if (
			pgid === undefined ||
			!(await processGroups.isActive(pgid).catch(() => true))
		)
			return undefined;
		const { ctx } = from;
		const notify = aborted || from !== session ? undefined : host.listener(ctx);
		if (!notify) {
			end(pgid, ctx);
			return undefined;
		}
		watch({ pgid, command, cwd }, ctx, notify);
		return pgid;
	}

	const operations: BashOperations = {
		async exec(command, cwd, options) {
			const from = session;
			if (!from) throw new Error("Command tracking ended with its session.");
			const fail = (error: unknown) =>
				host.track(Promise.reject(error), from.ctx);
			const directory = await mkdtemp(join(tmpdir(), "pi-subagents-command-"));
			const path = join(directory, "pgid");
			let endsLine = true;
			const onData = (data: Buffer) => {
				if (data.length) endsLine = data.at(-1) === 0x0a;
				options.onData(data);
			};
			try {
				const quoted = `'${path.replaceAll("'", "'\\''")}'`;
				return await from.shell.exec(
					`command printf '%s\\n' "$$" > ${quoted} || exit\n${command}`,
					cwd,
					{ ...options, onData },
				);
			} finally {
				const submitted =
					from.prefix && command.startsWith(`${from.prefix}\n`)
						? command.slice(from.prefix.length + 1)
						: command;
				const pgid = await record(
					from,
					path,
					submitted,
					cwd,
					options.signal?.aborted === true,
				).catch(fail);
				if (pgid !== undefined)
					options.onData(
						Buffer.from(
							`${endsLine ? "" : "\n"}[PGID ${pgid} tracked]\nYou will be notified on completion—don't poll the log or sleep while waiting. Read the log only if the user asks for progress or you need its output to proceed (e.g., a server's ready line or port).\n`,
						),
					);
				await rm(directory, { recursive: true, force: true }).catch(fail);
			}
		},
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		session = undefined;
		installed ||=
			process.platform !== "win32" &&
			pi
				.getAllTools()
				.some(
					(tool) =>
						tool.name === "bash" && tool.sourceInfo.source === "builtin",
				);
		if (!installed) return;
		const settings = SettingsManager.inMemory(pi.getSettings());
		const prefix = settings.getShellCommandPrefix();
		session = {
			ctx,
			prefix,
			shell: createLocalBashOperations({ shellPath: settings.getShellPath() }),
		};
		const bash = createBashToolDefinition(ctx.cwd, {
			operations,
			commandPrefix: prefix,
		});
		pi.registerTool({
			...bash,
			promptGuidelines: [
				...(bash.promptGuidelines ?? []),
				"Background jobs are tracked—you'll be notified (re-invoked if idle). To await a condition, background an `until` loop (`until <check>; do …; done > log 2>&1 &`).",
			],
			defaultActive: false,
		});
	});
	pi.on("tool_call", (event) => {
		if (
			!session ||
			!isToolCallEventType("bash", event) ||
			foregroundSleepSeconds(event.input.command) < SLEEP_LIMIT_SECONDS
		)
			return undefined;
		return {
			block: true,
			reason:
				"Blocked: foreground sleep. To await a condition, background an until loop. To wait for a tracked job, end your turn—you're re-invoked automatically on completion, so don't poll.",
		};
	});
	pi.on("user_bash", (event) =>
		session && !event.excludeFromContext ? { operations } : undefined,
	);
	pi.on("session_shutdown", () => {
		stop();
		session = undefined;
	});

	return { stop };
}

export function delegatedCommands({
	runtime,
	id,
}: SessionOwner): ExtensionFactory {
	return (pi) => {
		let unsubscribe = () => {};
		const commands = trackCommands(pi, {
			ownsJobs: true,
			track: (work, _ctx, leftover) =>
				runtime.trackCompletion(id, work, leftover),
			listener(ctx) {
				const session = runtime.get(id)?.session;
				if (!session) return undefined;
				const { sessionId } = session;
				const running = () => {
					const node = runtime.get(id);
					return (
						!runtime.closed &&
						node?.status === "running" &&
						!node.cancelled &&
						node.session === session &&
						servesSession(ctx, session.sessionManager, sessionId)
					);
				};
				if (!running()) return undefined;
				return async (message, signal) => {
					if (!running()) return;
					if (session.isCompacting && !session.isStreaming) {
						await session.waitForIdle();
						if (signal.aborted || !running()) return;
					}
					await runtime.notify(id, message, "steer");
				};
			},
		});
		pi.on("session_start", () => {
			unsubscribe();
			unsubscribe = runtime.subscribe(() => {
				if (runtime.get(id)?.cancelled) commands.stop();
			});
		});
		pi.on("session_shutdown", () => unsubscribe());
	};
}
