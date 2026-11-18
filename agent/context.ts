import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function servesSession(
	ctx: ExtensionContext,
	manager: ExtensionContext["sessionManager"],
	sessionId: string,
): boolean {
	try {
		return (
			ctx.sessionManager === manager && manager.getSessionId() === sessionId
		);
	} catch {
		return false;
	}
}
