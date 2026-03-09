import type { VoiceAgentTools } from "../../types";
import type { CompiledToolTrace, TraceExecutionResult } from "./types";

/**
 * Executes a compiled trace's steps sequentially against the tool API.
 *
 * Unlike the Claude tool-use loop, trace execution is deterministic —
 * each step runs with pre-computed args. If any step fails, execution
 * stops immediately and the error is reported.
 */
export class TraceRunner {
	private tools: VoiceAgentTools | null = null;

	setTools(tools: VoiceAgentTools): void {
		this.tools = tools;
	}

	async run(
		trace: CompiledToolTrace,
		resolvedArgs: Record<string, unknown>,
	): Promise<TraceExecutionResult> {
		if (!this.tools) {
			return {
				success: false,
				output: null,
				stepsExecuted: 0,
				error: "Tools not configured",
			};
		}

		let stepsExecuted = 0;
		let lastOutput: unknown = null;

		for (const step of trace.steps) {
			try {
				// Merge template args with resolved args
				const args = this.resolveStepArgs(step.argsTemplate, resolvedArgs);

				lastOutput = await this.executeTool(step.tool, args);
				stepsExecuted++;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					success: false,
					output: lastOutput,
					stepsExecuted,
					error: message,
				};
			}
		}

		return {
			success: true,
			output: lastOutput,
			stepsExecuted,
		};
	}

	private resolveStepArgs(
		template: Record<string, unknown>,
		resolved: Record<string, unknown>,
	): Record<string, unknown> {
		const args: Record<string, unknown> = { ...template };

		// Replace slot references with resolved values
		for (const [key, value] of Object.entries(args)) {
			if (typeof value === "string" && value.startsWith("$")) {
				const slotKey = value.slice(1);
				if (resolved[slotKey] !== undefined) {
					args[key] = resolved[slotKey];
				}
			}
		}

		return args;
	}

	private async executeTool(
		name: string,
		input: Record<string, unknown>,
	): Promise<unknown> {
		const tools = this.tools!;

		switch (name) {
			case "listWorkspaces":
				return tools.listWorkspaces();
			case "listNotifications":
				return tools.listNotifications();
			case "getAgentStatus":
				return tools.getAgentStatus(input.workspaceId as string);
			case "readTerminalOutput":
				return tools.readTerminalOutput(
					input as { workspaceId?: string; paneId?: string; lines?: number },
				);
			case "summarizeTerminal":
				return tools.summarizeTerminal(
					input as { workspaceId?: string; paneId?: string },
				);
			case "focusWorkspace":
				return tools.focusWorkspace(input.workspaceId as string);
			case "bringToFront":
				return tools.bringToFront();
			case "sendText":
				return tools.sendText(input.paneId as string, input.text as string);
			case "sendKeystroke":
				return tools.sendKeystroke(input.paneId as string, input.key as string);
			case "createWorkspace":
				return tools.createWorkspace(
					input as { projectId: string; name?: string; prompt?: string },
				);
			case "closeWorkspace":
				return tools.closeWorkspace(input.workspaceId as string);
			case "killWorkspaceAgents":
				return tools.killWorkspaceAgents(input.workspaceId as string);
			default:
				throw new Error(`Unknown tool in trace: ${name}`);
		}
	}
}
