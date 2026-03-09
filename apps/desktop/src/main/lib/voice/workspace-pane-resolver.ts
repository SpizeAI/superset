import { appState } from "../app-state";
import type { Pane } from "../app-state/schemas";

/**
 * Resolves workspace IDs to active pane IDs for terminal-targeted operations.
 *
 * The voice system often receives workspace-level commands ("read the terminal
 * in my auth workspace") but terminal operations are pane-addressed. This
 * resolver bridges that gap by finding the focused/active pane for a workspace.
 */
export class WorkspacePaneResolver {
	/**
	 * Resolve a workspace ID to its active/focused pane ID.
	 * Returns null if the workspace has no panes or doesn't exist.
	 */
	resolvePaneId(workspaceId: string): string | null {
		const { tabsState } = appState.data;

		// Check focused pane first
		const focusedPaneId = tabsState.focusedPaneIds?.[workspaceId];
		if (focusedPaneId && tabsState.panes[focusedPaneId]) {
			return focusedPaneId;
		}

		// Fall back to active tab's first pane
		const activeTabId = tabsState.activeTabIds?.[workspaceId];
		if (activeTabId) {
			const tab = tabsState.tabs.find((t) => t.id === activeTabId);
			if (tab) {
				// Find first terminal pane in this tab
				const terminalPane = Object.values(tabsState.panes).find(
					(p: Pane) => p.tabId === activeTabId && p.type === "terminal",
				);
				if (terminalPane) return terminalPane.id;

				// Any pane in this tab
				const anyPane = Object.values(tabsState.panes).find(
					(p: Pane) => p.tabId === activeTabId,
				);
				if (anyPane) return anyPane.id;
			}
		}

		// Last resort: any pane belonging to any tab in this workspace
		for (const tab of tabsState.tabs) {
			// Tab's workspace association is determined by its presence in activeTabIds
			const pane = Object.values(tabsState.panes).find(
				(p: Pane) => p.tabId === tab.id && p.type === "terminal",
			);
			if (pane) return pane.id;
		}

		return null;
	}

	/**
	 * Get all pane IDs for a workspace.
	 */
	getAllPaneIds(workspaceId: string): string[] {
		const { tabsState } = appState.data;
		const paneIds: string[] = [];

		// Collect panes from the workspace's active tab
		const activeTabId = tabsState.activeTabIds?.[workspaceId];
		if (activeTabId) {
			for (const pane of Object.values(tabsState.panes)) {
				if ((pane as Pane).tabId === activeTabId) {
					paneIds.push((pane as Pane).id);
				}
			}
		}

		return paneIds;
	}

	/**
	 * Verify a pane ID exists and is alive.
	 */
	isPaneAlive(paneId: string): boolean {
		const { tabsState } = appState.data;
		return !!tabsState.panes[paneId];
	}

	/**
	 * Get workspace ID from a pane ID (reverse lookup).
	 */
	getWorkspaceForPane(paneId: string): string | null {
		const { tabsState } = appState.data;
		const pane = tabsState.panes[paneId] as Pane | undefined;
		if (!pane) return null;

		// Find which workspace owns this tab
		for (const [wsId, tabId] of Object.entries(
			tabsState.activeTabIds ?? {},
		)) {
			if (tabId === pane.tabId) return wsId;
		}

		return null;
	}
}
