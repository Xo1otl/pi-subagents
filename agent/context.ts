import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Whether a context still serves the session it was captured with. Pi guards
 * a stale context's getters: they throw once its session is disposed or
 * replaced, even without a shutdown event.
 */
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
