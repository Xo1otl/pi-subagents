/** A thrown value's message, whatever was thrown. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whether a Node system call failed with this errno code, e.g. `ENOENT`. */
export function hasErrorCode(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
