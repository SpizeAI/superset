import type { VoiceAgentTools } from "../types";

/**
 * Tool definitions for the voice agent's Claude tool-use loop.
 *
 * Each entry maps to a method on VoiceAgentTools and describes it in a format
 * Claude can use for function calling. The actual implementations are injected
 * by the desktop adapter (voice-actions.ts) — this module only defines the
 * schema contract.
 */

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, ToolParameter>;
	risk: "safe" | "destructive";
}

export interface ToolParameter {
	type: "string" | "number" | "boolean";
	description: string;
	required: boolean;
}

export const VOICE_TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "listWorkspaces",
		description:
			"List all active workspaces with their agent status and pending notification count.",
		parameters: {},
		risk: "safe",
	},
	{
		name: "listNotifications",
		description:
			"List recent unread notifications across all workspaces.",
		parameters: {},
		risk: "safe",
	},
	{
		name: "getAgentStatus",
		description:
			"Get detailed agent status for a specific workspace, including current task and last activity.",
		parameters: {
			workspaceId: {
				type: "string",
				description: "The workspace ID to query.",
				required: true,
			},
		},
		risk: "safe",
	},
	{
		name: "readTerminalOutput",
		description:
			"Read recent terminal output lines from a workspace or specific pane.",
		parameters: {
			workspaceId: {
				type: "string",
				description: "Workspace ID (resolved to active pane if paneId omitted).",
				required: false,
			},
			paneId: {
				type: "string",
				description: "Specific pane ID to read from.",
				required: false,
			},
			lines: {
				type: "number",
				description: "Number of recent lines to return (default 50).",
				required: false,
			},
		},
		risk: "safe",
	},
	{
		name: "summarizeTerminal",
		description:
			"Get a concise AI summary of recent terminal activity in a workspace or pane.",
		parameters: {
			workspaceId: {
				type: "string",
				description: "Workspace ID.",
				required: false,
			},
			paneId: {
				type: "string",
				description: "Specific pane ID.",
				required: false,
			},
		},
		risk: "safe",
	},
	{
		name: "focusWorkspace",
		description:
			"Switch the UI to show a specific workspace tab.",
		parameters: {
			workspaceId: {
				type: "string",
				description: "The workspace to focus.",
				required: true,
			},
		},
		risk: "safe",
	},
	{
		name: "bringToFront",
		description:
			"Bring the Superset window to the foreground.",
		parameters: {},
		risk: "safe",
	},
	{
		name: "sendText",
		description:
			"Type text into a terminal pane. Use for running commands or providing input.",
		parameters: {
			paneId: {
				type: "string",
				description: "The pane to type into.",
				required: true,
			},
			text: {
				type: "string",
				description: "The text to type (include \\n for enter).",
				required: true,
			},
		},
		risk: "destructive",
	},
	{
		name: "sendKeystroke",
		description:
			"Send a keystroke to a terminal pane (e.g. ctrl+c, enter).",
		parameters: {
			paneId: {
				type: "string",
				description: "The pane to send to.",
				required: true,
			},
			key: {
				type: "string",
				description: "The key to send (e.g. 'ctrl+c', 'enter', 'y').",
				required: true,
			},
		},
		risk: "destructive",
	},
	{
		name: "createWorkspace",
		description:
			"Create a new workspace with an optional starting prompt.",
		parameters: {
			projectId: {
				type: "string",
				description: "The project to create the workspace in.",
				required: true,
			},
			name: {
				type: "string",
				description: "Optional workspace name.",
				required: false,
			},
			prompt: {
				type: "string",
				description: "Optional starting prompt for the agent.",
				required: false,
			},
		},
		risk: "destructive",
	},
	{
		name: "closeWorkspace",
		description:
			"Close a workspace and its associated terminal sessions.",
		parameters: {
			workspaceId: {
				type: "string",
				description: "The workspace to close.",
				required: true,
			},
		},
		risk: "destructive",
	},
	{
		name: "killWorkspaceAgents",
		description:
			"Kill all running agents in a workspace.",
		parameters: {
			workspaceId: {
				type: "string",
				description: "The workspace whose agents to kill.",
				required: true,
			},
		},
		risk: "destructive",
	},
];

/**
 * Convert tool definitions to the Claude function-calling format.
 */
export function toClaudeTools(): Array<{
	name: string;
	description: string;
	input_schema: {
		type: "object";
		properties: Record<string, unknown>;
		required: string[];
	};
}> {
	return VOICE_TOOL_DEFINITIONS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: {
			type: "object" as const,
			properties: Object.fromEntries(
				Object.entries(tool.parameters).map(([key, param]) => [
					key,
					{ type: param.type, description: param.description },
				]),
			),
			required: Object.entries(tool.parameters)
				.filter(([, param]) => param.required)
				.map(([key]) => key),
		},
	}));
}

/**
 * Check if a tool name corresponds to a destructive action.
 */
export function isDestructiveTool(toolName: string): boolean {
	const def = VOICE_TOOL_DEFINITIONS.find((t) => t.name === toolName);
	return def?.risk === "destructive";
}

// Tool names not sent to Claude but valid on VoiceAgentTools
const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set(["speak"]);

/**
 * Type guard to validate a tool name exists in the contract.
 */
export function isValidToolName(
	name: string,
): name is keyof VoiceAgentTools {
	return (
		VOICE_TOOL_DEFINITIONS.some((t) => t.name === name) ||
		INTERNAL_TOOL_NAMES.has(name)
	);
}
