import {
	type CachedAgentState,
	type CachedWorkspaceState,
	type VocabularyHints,
	VOICE_CONSTANTS,
	DEFAULT_VOCABULARY_HINTS,
} from "@superset/voice";

export interface StateCacheDeps {
	getWorkspaces: () => Promise<
		Array<{
			id: string;
			name: string;
			agentStatus: string;
			pendingNotifications: number;
			branchName?: string;
		}>
	>;
	getPaneId: (workspaceId: string) => string | null;
}

/**
 * Cached agent state for the voice system.
 *
 * Refreshes workspace metadata on a timer and exposes it to:
 * - The voice agent (for context injection into Claude prompts)
 * - The guard evaluator (for trace validation)
 * - The Whisper transcriber (for vocabulary priming hints)
 *
 * This avoids hitting the database on every voice interaction and
 * keeps vocabulary hints fresh for STT accuracy.
 */
export class VoiceStateCache {
	private state: CachedAgentState = {
		workspaces: [],
		vocabularyHints: { ...DEFAULT_VOCABULARY_HINTS },
		lastUpdatedAt: 0,
	};
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private deps: StateCacheDeps;

	constructor(deps: StateCacheDeps) {
		this.deps = deps;
	}

	start(): void {
		// Refresh immediately, then on interval
		this.refresh();
		this.refreshTimer = setInterval(
			() => this.refresh(),
			VOICE_CONSTANTS.STATE_CACHE_REFRESH_MS,
		);
	}

	stop(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	getState(): CachedAgentState {
		return this.state;
	}

	getVocabularyHints(): VocabularyHints {
		return this.state.vocabularyHints;
	}

	/**
	 * Force a cache refresh. Called after significant state changes
	 * (new workspace created, workspace closed, etc.)
	 */
	async refresh(): Promise<void> {
		try {
			const workspaces = await this.deps.getWorkspaces();

			const cachedWorkspaces: CachedWorkspaceState[] = workspaces.map(
				(ws) => ({
					workspaceId: ws.id,
					workspaceName: ws.name,
					paneId: this.deps.getPaneId(ws.id) ?? undefined,
					branchName: ws.branchName,
					agentStatus: ws.agentStatus as CachedWorkspaceState["agentStatus"],
					pendingNotifications: ws.pendingNotifications,
					lastActivityAt: Date.now(),
				}),
			);

			// Build vocabulary hints from live workspace data
			const workspaceNames = workspaces.map((ws) => ws.name);
			const branchNames = workspaces
				.map((ws) => ws.branchName)
				.filter((b): b is string => !!b);

			const vocabularyHints: VocabularyHints = {
				workspaceNames: [...new Set(workspaceNames)],
				branchNames: [...new Set(branchNames)],
				technicalTerms: DEFAULT_VOCABULARY_HINTS.technicalTerms,
			};

			this.state = {
				workspaces: cachedWorkspaces,
				vocabularyHints,
				lastUpdatedAt: Date.now(),
			};
		} catch (error) {
			console.warn("[voice:state-cache] Refresh failed:", error);
		}
	}
}
