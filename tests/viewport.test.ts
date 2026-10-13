import { expect, test } from "bun:test";
import type { TranscriptLayout } from "../ui/transcript.ts";
import { createTranscriptViewport } from "../ui/viewport.ts";

function layout(...blocks: [string, number][]): TranscriptLayout {
	return {
		rows: blocks.flatMap(([blockId, count]) =>
			Array.from({ length: count }, (_, offset) => ({
				text: `${blockId}:${offset}`,
				blockId,
				offset,
			})),
		),
	};
}

test("follows incoming output only at the bottom; scrolled history is anchored to content", () => {
	const viewport = createTranscriptViewport();
	const first = layout(["earlier", 30], ["live", 20]);
	expect(viewport.window(first, 10)).toMatchObject({
		top: 40,
		following: true,
	});
	viewport.scrollBy(first, 10, -20);
	expect(viewport.window(first, 10)).toMatchObject({
		top: 20,
		following: false,
	});
	const incoming = layout(["earlier", 30], ["live", 80], ["new", 50]);
	expect(viewport.window(incoming, 10)).toMatchObject({
		top: 20,
		following: false,
	});
	viewport.follow();
	expect(viewport.window(incoming, 10)).toMatchObject({
		top: 150,
		following: true,
	});
});

test("growing or folding earlier tool blocks preserves the visible message and line offset", () => {
	const viewport = createTranscriptViewport();
	const first = layout(["tool", 10], ["message", 40], ["tail", 20]);
	viewport.scrollBy(first, 10, -40); // message offset 10
	expect(first.rows[viewport.window(first, 10).top]?.text).toBe("message:10");
	const expanded = layout(["tool", 100], ["message", 40], ["tail", 20]);
	expect(expanded.rows[viewport.window(expanded, 10).top]?.text).toBe(
		"message:10",
	);
	const collapsed = layout(["tool", 1], ["message", 40], ["tail", 20]);
	expect(collapsed.rows[viewport.window(collapsed, 10).top]?.text).toBe(
		"message:10",
	);
});

test("rendering resized or reflowed layouts does not mutate a scroll bookmark", () => {
	const viewport = createTranscriptViewport();
	const first = layout(["message", 60], ["tail", 20]);
	viewport.scrollBy(first, 10, -40);
	const expected = viewport.window(first, 10);
	viewport.window(first, 1000);
	viewport.window(layout(["message", 10], ["tail", 20]), 20);
	expect(viewport.window(first, 10)).toEqual(expected);
});

test("scrolling back to the end resumes following; pinning before expansion does not", () => {
	const viewport = createTranscriptViewport();
	const first = layout(["message", 60]);
	viewport.scrollBy(first, 10, -1000);
	expect(viewport.window(first, 10).top).toBe(0);
	viewport.scrollBy(first, 10, 1000);
	expect(viewport.window(first, 10).following).toBe(true);
	viewport.hold(first, 10);
	expect(viewport.window(layout(["message", 100]), 10)).toMatchObject({
		top: 50,
		following: false,
	});
	viewport.top(first);
	expect(viewport.window(first, 10).top).toBe(0);
});
