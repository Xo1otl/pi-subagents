import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Subagents } from "../runtime/index.ts";

const WIDGET_KEY = "pi-subagents.running";

/** A root-session widget independent of the switcher and the root's own run. */
export function bindRunningIndicator(
	runtime: Subagents,
	ui: Pick<ExtensionUIContext, "setWidget">,
): () => void {
	let summary = "";
	let disposed = false;
	let unsubscribe = () => {};

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		if (summary) ui.setWidget(WIDGET_KEY, undefined);
		summary = "";
	}

	function update(): void {
		if (disposed) return;
		if (runtime.closed) {
			dispose();
			return;
		}
		const active = runtime.tree().filter((node) => node.status === "running");
		const stopping = active.filter((node) => node.cancelled).length;
		const running = active.length - stopping;
		const counts = [
			...(running ? [`${running} running`] : []),
			...(stopping ? [`${stopping} stopping`] : []),
		].join(" · ");
		const ids = active
			.slice(0, 3)
			.map((node) => node.id)
			.join(", ");
		const next = active.length
			? `● Subagents: ${counts} · ${ids}${active.length > 3 ? ", …" : ""}`
			: "";
		// Token streaming should not reinstall or redraw an unchanged widget.
		if (next === summary) return;
		summary = next;
		if (!summary) {
			ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
			render: (width) => [
				truncateToWidth(
					theme.fg("warning", next) +
						theme.fg("dim", " · ←← / Ctrl+Shift+A to view"),
					width,
				),
			],
			invalidate() {},
		}));
	}

	unsubscribe = runtime.subscribe(update);
	update();
	return dispose;
}
