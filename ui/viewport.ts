import { ScrollView } from "@earendil-works/pi-tui";
import type { TranscriptLayout } from "./transcript.ts";

interface Anchor {
	blockId: string;
	offset: number;
	fallbackTop: number;
}

export interface TranscriptWindow {
	top: number;
	maxTop: number;
	following: boolean;
}

/** Semantic scroll anchoring on top of Pi's bounded/follow-end scroll state.
 * Rendering only derives a window; resize or invalidation cannot erase a bookmark.
 */
export function createTranscriptViewport() {
	const scroll = new ScrollView(
		{ render: () => [], invalidate() {} },
		{ follow: "end", overscroll: "contain" },
	);
	let anchor: Anchor | undefined;

	function window(layout: TranscriptLayout, height: number): TranscriptWindow {
		height = Math.max(0, height);
		const maxTop = Math.max(0, layout.rows.length - height);
		if (!anchor) return { top: maxTop, maxTop, following: true };
		const start = layout.rows.findIndex(
			(row) => row.blockId === anchor?.blockId,
		);
		let top = anchor.fallbackTop;
		if (start >= 0) {
			top = start;
			for (let index = start; index < layout.rows.length; index++) {
				const row = layout.rows[index];
				if (row?.blockId !== anchor.blockId) break;
				top = index;
				if (row.offset >= anchor.offset) break;
			}
		}
		return {
			top: Math.max(0, Math.min(top, maxTop)),
			maxTop,
			following: false,
		};
	}

	function save(layout: TranscriptLayout, top: number): void {
		const row = layout.rows[top];
		if (row)
			anchor = { blockId: row.blockId, offset: row.offset, fallbackTop: top };
	}

	return {
		window,
		scrollBy(layout: TranscriptLayout, height: number, delta: number): void {
			const view = window(layout, height);
			scroll.updateLayout(layout.rows.length, height, () => {});
			scroll.scrollTo(view.top, { disableFollow: !view.following });
			scroll.scrollBy(delta);
			if (scroll.isFollowingEnd) anchor = undefined;
			else save(layout, scroll.scrollTop);
		},
		/** Freeze the current content before expanding or hiding earlier blocks. */
		hold(layout: TranscriptLayout, height: number): void {
			save(layout, window(layout, height).top);
		},
		top(layout: TranscriptLayout): void {
			save(layout, 0);
		},
		follow(): void {
			anchor = undefined;
		},
	};
}

export type TranscriptViewport = ReturnType<typeof createTranscriptViewport>;
