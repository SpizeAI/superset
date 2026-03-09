import type { VoiceAgentTools } from "@superset/voice";
import { BrowserWindow } from "electron";
import { getDaemonTerminalManager } from "../terminal";
import { WorkspacePaneResolver } from "./workspace-pane-resolver";

/**
 * Desktop adapter implementing VoiceAgentTools.
 *
 * Each method maps a voice tool call to the appropriate desktop API.
 * Terminal operations go through the DaemonTerminalManager, window
 * operations through Electron APIs, and workspace state through appState.
 */
export function createVoiceActions(deps: {
	getWorkspaces: () => Promise<
		Array<{
			id: string;
			name: string;
			agentStatus: string;
			pendingNotifications: number;
		}>
	>;
	getNotifications: () => Promise<
		Array<{
			id: string;
			type: string;
			workspaceId?: string;
			message: string;
			receivedAt: number;
		}>
	>;
	readTerminalBuffer: (paneId: string, lines: number) => Promise<string>;
	focusTab: (workspaceId: string) => void;
}): VoiceAgentTools {
	const resolver = new WorkspacePaneResolver();

	return {
		async listWorkspaces() {
			const workspaces = await deps.getWorkspaces();
			return workspaces.map((ws) => ({
				workspaceId: ws.id,
				name: ws.name,
				agentStatus: ws.agentStatus as
					| "running"
					| "idle"
					| "error"
					| "waiting-permission",
				pendingNotifications: ws.pendingNotifications,
			}));
		},

		async listNotifications() {
			return deps.getNotifications();
		},

		async getAgentStatus(workspaceId: string) {
			const workspaces = await deps.getWorkspaces();
			const ws = workspaces.find((w) => w.id === workspaceId);
			if (!ws) {
				throw new Error(`Workspace ${workspaceId} not found`);
			}
			return {
				status: ws.agentStatus as
					| "running"
					| "idle"
					| "error"
					| "waiting-permission",
				workspaceId: ws.id,
				lastActivityAt: Date.now(),
			};
		},

		async readTerminalOutput(input) {
			const paneId =
				input.paneId ??
				(input.workspaceId
					? resolver.resolvePaneId(input.workspaceId)
					: null);

			if (!paneId) {
				throw new Error(
					"Could not resolve pane. Please specify a workspace or pane.",
				);
			}

			return deps.readTerminalBuffer(paneId, input.lines ?? 50);
		},

		async summarizeTerminal(input) {
			// For MVP, return raw terminal output. Full summarization
			// will use Claude in a future commit.
			const paneId =
				input.paneId ??
				(input.workspaceId
					? resolver.resolvePaneId(input.workspaceId)
					: null);

			if (!paneId) {
				throw new Error(
					"Could not resolve pane. Please specify a workspace or pane.",
				);
			}

			const output = await deps.readTerminalBuffer(paneId, 100);
			return output.length > 0
				? output
				: "No recent terminal output.";
		},

		async focusWorkspace(workspaceId: string) {
			deps.focusTab(workspaceId);
		},

		async bringToFront() {
			const windows = BrowserWindow.getAllWindows();
			const mainWindow = windows[0];
			if (mainWindow) {
				if (mainWindow.isMinimized()) mainWindow.restore();
				mainWindow.focus();
			}
		},

		async sendText(paneId: string, text: string) {
			if (!resolver.isPaneAlive(paneId)) {
				throw new Error(`Pane ${paneId} not found or not alive`);
			}
			const terminal = getDaemonTerminalManager();
			terminal.write({ paneId, data: text });
		},

		async sendKeystroke(paneId: string, key: string) {
			if (!resolver.isPaneAlive(paneId)) {
				throw new Error(`Pane ${paneId} not found or not alive`);
			}

			// Map common key names to terminal escape sequences
			const keyMap: Record<string, string> = {
				enter: "\r",
				"ctrl+c": "\x03",
				"ctrl+d": "\x04",
				"ctrl+z": "\x1a",
				"ctrl+l": "\x0c",
				escape: "\x1b",
				tab: "\t",
				y: "y",
				n: "n",
			};

			const data = keyMap[key.toLowerCase()] ?? key;
			const terminal = getDaemonTerminalManager();
			terminal.write({ paneId, data });
		},

		async createWorkspace(_input) {
			// Workspace creation requires project context that will be
			// wired in a later commit when the full workspace API is integrated.
			throw new Error("Workspace creation not yet implemented via voice");
		},

		async closeWorkspace(_workspaceId) {
			// Workspace closing requires careful cleanup of terminal sessions
			// and UI state. Will be wired in a later commit.
			throw new Error("Workspace closing not yet implemented via voice");
		},

		async killWorkspaceAgents(workspaceId: string) {
			const paneIds = resolver.getAllPaneIds(workspaceId);
			let killed = 0;
			let failed = 0;

			const terminal = getDaemonTerminalManager();
			for (const paneId of paneIds) {
				try {
					// Send SIGINT to interrupt running agents
					terminal.write({ paneId, data: "\x03" });
					killed++;
				} catch {
					failed++;
				}
			}

			return { killed, failed };
		},

		async speak(_text: string) {
			// TTS is handled by the pipeline, not as a tool action.
			// This is a no-op when called as a tool.
		},
	};
}
