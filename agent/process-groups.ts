import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { hasErrorCode } from "../runtime/errors.ts";

const exec = promisify(execFile);

/** How long a group's status may stay unknown before its watcher says so. */
export const UNKNOWN_STATUS_REPORT_MS = 60_000;

/** Wait independently of the shell/tool, without blocking the agent's turn.
 * Polling backs off, as a job may be a server that runs for days.
 *
 * A check can fail, e.g. `ps` timing out under load, while the group runs on:
 * failures neither end the wait nor pass for the group's end. Once the status
 * has stayed unknown for `unknownAfterMs`, `onUnknown` is told, once; waiting
 * continues, and only rejects on abort or when `onUnknown` fails.
 */
export async function waitForGroupToFinish(
	pgid: number,
	signal?: AbortSignal,
	onUnknown?: (error: unknown) => void | Promise<void>,
	unknownAfterMs = UNKNOWN_STATUS_REPORT_MS,
): Promise<void> {
	assertProcessGroup(pgid);
	let unknownSince: number | undefined;
	let told = false;
	for (let delay = 100; ; delay = Math.min(delay * 2, 1000)) {
		try {
			if (!(await isProcessGroupActive(pgid, signal))) return;
			unknownSince = undefined;
		} catch (error) {
			signal?.throwIfAborted();
			unknownSince ??= performance.now();
			if (!told && performance.now() - unknownSince >= unknownAfterMs) {
				told = true;
				await onUnknown?.(error);
			}
		}
		await setTimeout(delay, undefined, { signal });
	}
}

/** A shell can exit before its background jobs, which retain its POSIX process
 * group even after reparenting (including nohup). Zombies have finished too;
 * kill(-pgid, 0) alone would wait forever on systems that do not reap them.
 * Processes that explicitly leave the group (setsid/setpgid) are not included.
 */
export async function isProcessGroupActive(
	pgid: number,
	signal?: AbortSignal,
): Promise<boolean> {
	assertProcessGroup(pgid);
	signal?.throwIfAborted();
	try {
		process.kill(-pgid, 0);
	} catch (error) {
		if (hasErrorCode(error, "ESRCH")) return false;
		throw error;
	}
	// Linux needs no subprocess, which could itself fail under load.
	if (process.platform === "linux") return hasLiveMember(pgid);
	const { stdout } = await exec("ps", ["-A", "-o", "pgid=,stat="], {
		signal,
		timeout: 5000,
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout.split("\n").some((line) => {
		if (!line.trim()) return false;
		const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
		if (!match) throw new Error(`Invalid process status: ${line}`);
		return Number(match[1]) === pgid && !/^[ZX]/.test(match[2] ?? "");
	});
}

function assertProcessGroup(pgid: number): void {
	if (!Number.isSafeInteger(pgid) || pgid <= 1)
		throw new Error(`Invalid process group: ${pgid}`);
	if (process.platform === "win32")
		throw new Error(
			"Command completion tracking requires POSIX process groups.",
		);
}

/** Whether procfs lists a member of the group that has not finished. */
async function hasLiveMember(pgid: number): Promise<boolean> {
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		let stat: string;
		try {
			stat = await readFile(`/proc/${entry}/stat`, "utf8");
		} catch (error) {
			// Exited since the listing.
			if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ESRCH"))
				continue;
			throw error;
		}
		// `pid (comm) state ppid pgrp …`, where comm may contain anything.
		const [state, , group] = stat
			.slice(stat.lastIndexOf(")") + 2)
			.split(" ", 3);
		if (!state || !group) throw new Error(`Invalid process status: ${stat}`);
		if (Number(group) === pgid && !/^[ZXx]/.test(state)) return true;
	}
	return false;
}
