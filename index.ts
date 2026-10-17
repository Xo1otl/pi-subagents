import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentIntegration } from "./agent/index.ts";
import { createSubagentUI } from "./ui/index.ts";

export default function subagentsExtension(pi: ExtensionAPI): void {
	const ui = createSubagentUI(pi);
	const tool = createSubagentIntegration(pi, ui);
	pi.registerTool({ ...tool, ...ui.toolRenderers });
}
