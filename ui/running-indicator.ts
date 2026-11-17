import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Subagent, Subagents } from "../runtime/index.ts";

const WIDGET_KEY = "pi-subagents.running";
/** IDs listed before eliding the rest. */
const LISTED_IDS = 3;

/** `● Subagents: 2 running · 1 stopping · 1, 1.1, 2`, or "" when none are active. */
function summarize(nodes: readonly Subagent[]): string {
	const active = nodes.filter((node) => node.status === "running");
	if (!active.length) return "";
	const stopping = active.filter((node) => node.cancelled).length;
	const running = active.length - stopping;
	const counts = [
		running && `${running} running`,
		stopping && `${stopping} stopping`,
	]
		.filter(Boolean)
		.join(" · ");
	const ids = active.slice(0, LISTED_IDS).map((node) => node.id);
	if (active.length > LISTED_IDS) ids.push("…");
	return `● Subagents: ${counts} · ${ids.join(", ")}`;
}

/** A root-session widget independent of the switcher and the root's own run. */
export function bindRunningIndicator(
	runtime: Subagents,
	ui: Pick<ExtensionUIContext, "setWidget">,
): () => void {
	let summary = "";
	let disposed = false;

	function show(next: string): void {
		// Token streaming should not reinstall or redraw an unchanged widget.
		if (next === summary) return;
		summary = next;
		ui.setWidget(
			WIDGET_KEY,
			next
				? (_tui, theme) => ({
						render: (width) => [
							truncateToWidth(
								theme.fg("warning", next) +
									theme.fg("dim", " · ←← / Ctrl+Shift+A to view"),
								width,
							),
						],
						invalidate() {},
					})
				: undefined,
		);
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		show("");
	}

	function update(): void {
		if (disposed) return;
		if (runtime.closed) dispose();
		else show(summarize(runtime.tree()));
	}

	const unsubscribe = runtime.subscribe(update);
	update();
	return dispose;
}
