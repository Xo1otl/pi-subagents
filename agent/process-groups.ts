import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { hasErrorCode } from "../runtime/errors.ts";

const exec = promisify(execFile);

export const UNKNOWN_STATUS_REPORT_MS = 60_000;

export interface GroupWatch {
	signal?: AbortSignal;
	onUnknown?: (error: unknown) => void | Promise<void>;
}

export async function waitForGroupToFinish(
	pgid: number,
	watch: GroupWatch = {},
): Promise<void> {
	assertProcessGroup(pgid);
	const { signal } = watch;
	return pollGroup(() => isProcessGroupActive(pgid, signal), watch);
}

const pollClock = {
	now: () => performance.now(),
	sleep: (delay: number, signal?: AbortSignal) =>
		setTimeout(delay, undefined, { signal }),
};

export async function pollGroup(
	isActive: () => Promise<boolean>,
	{ signal, onUnknown }: GroupWatch,
	clock = pollClock,
): Promise<void> {
	let unknownSince: number | undefined;
	let told = false;
	for (let delay = 100; ; delay = Math.min(delay * 2, 1000)) {
		try {
			if (!(await isActive())) return;
			unknownSince = undefined;
		} catch (error) {
			signal?.throwIfAborted();
			const now = clock.now();
			unknownSince ??= now;
			if (!told && now - unknownSince >= UNKNOWN_STATUS_REPORT_MS) {
				told = true;
				await onUnknown?.(error);
			}
		}
		await clock.sleep(delay, signal);
	}
}

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

export function liveProcessGroup(stat: string): number | undefined {
	// Linux's comm field is parenthesized and may itself contain spaces or ')'.
	const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ", 3);
	if (!state || !group) throw new Error(`Invalid process status: ${stat}`);
	return /^[ZXx]/.test(state) ? undefined : Number(group);
}

async function hasLiveMember(pgid: number): Promise<boolean> {
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		let stat: string;
		try {
			stat = await readFile(`/proc/${entry}/stat`, "utf8");
		} catch (error) {
			if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ESRCH"))
				continue;
			throw error;
		}
		if (liveProcessGroup(stat) === pgid) return true;
	}
	return false;
}
