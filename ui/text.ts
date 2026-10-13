import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Remove untrusted terminal controls before rendering session/tool text. */
export function plain(text: string): string {
	return stripTerminalSequences(text)
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Remove untrusted terminal control characters.
			/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
			"",
		)
		.replace(/\t/g, "    ");
}

/** Inline labels must never introduce an extra physical terminal row. */
export function singleLine(text: string): string {
	return plain(text).replace(/\s+/g, " ");
}
