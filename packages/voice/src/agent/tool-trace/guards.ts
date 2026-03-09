import type { GuardContext, GuardResult } from "./types";

/**
 * Guard function type. Each guard validates a single precondition.
 */
export type GuardFn = (context: GuardContext) => GuardResult;

/**
 * Built-in guard implementations.
 *
 * Guards are the safety layer between trace lookup and execution.
 * Every guard must pass before a cached trace can run. If any guard
 * fails, the system falls back to the full Claude pipeline.
 */

export const GUARDS: Record<string, GuardFn> = {
	/**
	 * Verify the target workspace still exists in cached state.
	 */
	workspace_exists: (context) => {
		const workspaceId = context.resolvedArgs.workspace as string | undefined;
		if (!workspaceId) {
			return { ok: false, failedGuard: "workspace_exists", reason: "No workspace specified" };
		}

		if (!context.cachedState) {
			return { ok: false, failedGuard: "workspace_exists", reason: "No cached state available" };
		}

		const exists = context.cachedState.workspaces.some(
			(ws) => ws.workspaceId === workspaceId,
		);

		return exists
			? { ok: true }
			: { ok: false, failedGuard: "workspace_exists", reason: `Workspace ${workspaceId} not found` };
	},

	/**
	 * Verify the target pane is alive in cached state.
	 */
	pane_alive: (context) => {
		const paneId = context.resolvedArgs.pane as string | undefined;
		if (!paneId) {
			return { ok: false, failedGuard: "pane_alive", reason: "No pane specified" };
		}

		if (!context.cachedState) {
			return { ok: false, failedGuard: "pane_alive", reason: "No cached state available" };
		}

		const alive = context.cachedState.workspaces.some(
			(ws) => ws.paneId === paneId,
		);

		return alive
			? { ok: true }
			: { ok: false, failedGuard: "pane_alive", reason: `Pane ${paneId} not found` };
	},

	/**
	 * Verify a pending permission request exists for approve-style actions.
	 */
	pending_permission_exists: (context) => {
		if (!context.cachedState) {
			return { ok: false, failedGuard: "pending_permission_exists", reason: "No cached state" };
		}

		const hasWaiting = context.cachedState.workspaces.some(
			(ws) => ws.agentStatus === "waiting-permission",
		);

		return hasWaiting
			? { ok: true }
			: { ok: false, failedGuard: "pending_permission_exists", reason: "No pending permissions" };
	},

	/**
	 * Destructive traces require a confirmation token.
	 * This is a marker guard — actual token validation happens in the pipeline.
	 */
	requires_confirmation_token: (_context) => {
		// This guard always passes at the guard level.
		// The pipeline layer enforces the actual token requirement
		// before executing destructive trace steps.
		return { ok: true };
	},

	/**
	 * Prevent trace execution while TTS is actively playing.
	 * Avoids overlapping actions with speech output.
	 */
	not_while_speaking: (_context) => {
		// Evaluated by the pipeline state machine, not here.
		// The guard evaluator receives pipeline state as context
		// in the full integration (Commit 23).
		return { ok: true };
	},
};
