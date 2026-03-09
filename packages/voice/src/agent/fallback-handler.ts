import type { CachedAgentState, VoiceAgentResponse } from "../types";

/**
 * Fallback handler for when the Claude API is unavailable.
 *
 * Provides basic pattern-matched responses using cached workspace state.
 * This ensures the voice system degrades gracefully — users can still get
 * workspace status and basic navigation even without cloud connectivity.
 */
export class FallbackHandler {
	async processUtterance(
		text: string,
		cachedState?: CachedAgentState,
	): Promise<VoiceAgentResponse> {
		const start = Date.now();
		const normalized = text.toLowerCase().trim();
		let responseText: string;

		if (this.matchesPattern(normalized, ["notification", "alert", "pending"])) {
			responseText = this.buildNotificationResponse(cachedState);
		} else if (this.matchesPattern(normalized, ["status", "how are", "how's", "what's going on", "update"])) {
			responseText = this.buildStatusResponse(cachedState);
		} else if (this.matchesPattern(normalized, ["list", "workspaces"])) {
			responseText = this.buildWorkspaceList(cachedState);
		} else {
			responseText =
				"I'm having trouble reaching the AI service right now. I can still tell you workspace status if you ask.";
		}

		return {
			text: responseText,
			executionPath: "fallback",
			durationMs: Date.now() - start,
		};
	}

	private matchesPattern(text: string, keywords: string[]): boolean {
		return keywords.some((kw) => text.includes(kw));
	}

	private buildStatusResponse(state?: CachedAgentState): string {
		if (!state || state.workspaces.length === 0) {
			return "No active workspaces right now.";
		}

		const running = state.workspaces.filter((ws) => ws.agentStatus === "running");
		const waiting = state.workspaces.filter(
			(ws) => ws.agentStatus === "waiting-permission",
		);
		const errored = state.workspaces.filter((ws) => ws.agentStatus === "error");

		const parts: string[] = [];

		if (running.length > 0) {
			parts.push(
				`${running.length} workspace${running.length > 1 ? "s" : ""} running`,
			);
		}
		if (waiting.length > 0) {
			parts.push(
				`${waiting.length} waiting for permission`,
			);
		}
		if (errored.length > 0) {
			parts.push(`${errored.length} with errors`);
		}

		if (parts.length === 0) {
			return `${state.workspaces.length} workspace${state.workspaces.length > 1 ? "s" : ""} idle.`;
		}

		return `${parts.join(", ")}.`;
	}

	private buildWorkspaceList(state?: CachedAgentState): string {
		if (!state || state.workspaces.length === 0) {
			return "No active workspaces.";
		}

		if (state.workspaces.length <= 3) {
			const names = state.workspaces
				.map((ws) => `${ws.workspaceName} is ${ws.agentStatus}`)
				.join(", ");
			return names + ".";
		}

		return `You have ${state.workspaces.length} workspaces open. The most active ones are ${state.workspaces
			.slice(0, 3)
			.map((ws) => ws.workspaceName)
			.join(", ")}.`;
	}

	private buildNotificationResponse(state?: CachedAgentState): string {
		if (!state) return "No notifications available.";

		const total = state.workspaces.reduce(
			(sum, ws) => sum + ws.pendingNotifications,
			0,
		);

		if (total === 0) return "No pending notifications.";

		const withNotifications = state.workspaces.filter(
			(ws) => ws.pendingNotifications > 0,
		);

		if (withNotifications.length === 1) {
			const ws = withNotifications[0]!;
			return `${ws.pendingNotifications} notification${ws.pendingNotifications > 1 ? "s" : ""} from ${ws.workspaceName}.`;
		}

		return `${total} notifications across ${withNotifications.length} workspaces.`;
	}
}
