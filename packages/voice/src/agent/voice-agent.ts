import type {
	CachedAgentState,
	ExecutionPath,
	VoiceAgentResponse,
	VoiceAgentTools,
} from "../types";
import { isDestructiveTool, toClaudeTools } from "./tools";
import { TraceIndex } from "./tool-trace/trace-index";
import {
	TraceCompiler,
	type TranscriptRecord,
	type ToolCallRecord,
} from "./tool-trace/trace-compiler";
import { GuardEvaluator } from "./tool-trace/guard-evaluator";
import { TraceRunner } from "./tool-trace/trace-runner";

export interface VoiceAgentOptions {
	apiKey: string;
	model?: string;
	maxToolCalls?: number;
	traceEnabled?: boolean;
	traceMaxEntries?: number;
	traceTtlMs?: number;
}

interface ClaudeMessage {
	role: "user" | "assistant";
	content: string | ClaudeContentBlock[];
}

interface ClaudeContentBlock {
	type: "text" | "tool_use" | "tool_result";
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string;
	is_error?: boolean;
}

const SYSTEM_PROMPT = `You are Superset's voice assistant. You help users monitor and control their agent workspaces using voice commands.

Rules:
- Be extremely concise. Users are listening, not reading. Max 2 sentences per response.
- Use natural spoken language. No markdown, no code blocks, no bullet lists.
- When listing workspaces, use names not IDs.
- For destructive actions (sending text, closing workspaces, killing agents), confirm the action clearly before executing.
- If a workspace or pane is ambiguous, ask the user to clarify.
- Always call the appropriate tool rather than guessing at state.`;

/**
 * Voice agent powered by Claude tool-use.
 *
 * Receives transcribed utterances, builds context from cached state,
 * runs a tool-use loop against Claude, and returns a concise spoken response.
 * The agent is stateless between calls — conversation context is passed in.
 */
export class VoiceAgent {
	private readonly apiKey: string;
	private readonly model: string;
	private readonly maxToolCalls: number;
	private tools: VoiceAgentTools | null = null;

	// Trace fast-path components
	private traceEnabled: boolean;
	private readonly traceIndex: TraceIndex;

	private readonly traceCompiler: TraceCompiler;
	private readonly guardEvaluator: GuardEvaluator;
	private readonly traceRunner: TraceRunner;

	constructor(options: VoiceAgentOptions) {
		this.apiKey = options.apiKey;
		this.model = options.model ?? "claude-sonnet-4-20250514";
		this.maxToolCalls = options.maxToolCalls ?? 5;

		this.traceEnabled = options.traceEnabled ?? false;
		this.traceIndex = new TraceIndex({
			maxEntries: options.traceMaxEntries,
			defaultTtlMs: options.traceTtlMs,
		});
		this.traceCompiler = new TraceCompiler({
			defaultTtlMs: options.traceTtlMs,
		});
		this.guardEvaluator = new GuardEvaluator();
		this.traceRunner = new TraceRunner();
	}

	setTools(tools: VoiceAgentTools): void {
		this.tools = tools;
		this.traceRunner.setTools(tools);
	}

	async processUtterance(
		text: string,
		conversationContext: string[],
		cachedState?: CachedAgentState,
	): Promise<VoiceAgentResponse> {
		if (!this.tools) {
			throw new Error("[voice:agent] Tools not configured");
		}

		const start = Date.now();

		// ── Trace fast path ──────────────────────────────────────────────
		if (this.traceEnabled) {
			const traceResult = this.tryTracePath(
				text,
				conversationContext,
				cachedState,
			);
			if (traceResult) {
				const result = await traceResult;
				if (result) {
					return {
						...result,
						durationMs: Date.now() - start,
					};
				}
			}
		}

		// ── Claude tool-use path ─────────────────────────────────────────
		return this.runClaudePath(text, conversationContext, cachedState, start);
	}

	/**
	 * Attempt the trace fast path: match → guard → run.
	 * Returns null if no match, guard failure, or destructive trace
	 * without confirmation token.
	 */
	private tryTracePath(
		text: string,
		conversationContext: string[],
		cachedState?: CachedAgentState,
	): Promise<Omit<VoiceAgentResponse, "durationMs"> | null> | null {
		const match = this.traceIndex.match(text, conversationContext);
		if (!match) return null;

		const guardContext = {
			cachedState: cachedState
				? {
						workspaces: cachedState.workspaces.map((ws) => ({
							workspaceId: ws.workspaceId,
							agentStatus: ws.agentStatus,
							paneId: ws.paneId,
						})),
					}
				: null,
			conversation: conversationContext,
			resolvedArgs: match.args,
		};

		const guardResult = this.guardEvaluator.evaluate(
			match.trace,
			guardContext,
		);

		if (!guardResult.ok) {
			console.warn(
				`[voice:agent] Guard failed for trace ${match.trace.id}: ${guardResult.reason}`,
			);
			return null;
		}

		// Destructive traces require confirmation — don't run via fast path,
		// fall back to Claude so it can ask for confirmation naturally
		if (match.trace.risk === "destructive") {
			return null;
		}

		return this.executeTrace(match.trace, match.args);
	}

	private async executeTrace(
		trace: import("../types").CompiledToolTrace,
		args: Record<string, unknown>,
	): Promise<Omit<VoiceAgentResponse, "durationMs"> | null> {
		const result = await this.traceRunner.run(trace, args);

		if (!result.success) {
			console.warn(
				`[voice:agent] Trace execution failed: ${result.error}`,
			);
			return null;
		}

		return {
			text:
				typeof result.output === "string"
					? result.output
					: "Done.",
			executionPath: "trace" as const,
			traceId: trace.id,
		};
	}

	/**
	 * Full Claude tool-use loop. On success, compiles a trace and inserts
	 * it into the index for future fast-path matches.
	 */
	private async runClaudePath(
		text: string,
		conversationContext: string[],
		cachedState: CachedAgentState | undefined,
		start: number,
	): Promise<VoiceAgentResponse> {
		const messages: ClaudeMessage[] = this.buildMessages(
			text,
			conversationContext,
			cachedState,
		);

		let toolCallCount = 0;
		const toolCallRecords: ToolCallRecord[] = [];
		let responseText = "";

		while (toolCallCount < this.maxToolCalls) {
			const response = await this.callClaude(messages);

			const textBlocks = response.content.filter(
				(b: ClaudeContentBlock) => b.type === "text",
			);
			const toolUseBlocks = response.content.filter(
				(b: ClaudeContentBlock) => b.type === "tool_use",
			);

			if (toolUseBlocks.length === 0) {
				responseText =
					textBlocks.map((b: ClaudeContentBlock) => b.text).join(" ") ||
					"I couldn't process that request.";

				this.maybeCompileTrace(text, toolCallRecords, responseText);

				return {
					text: responseText,
					executionPath: "claude",
					durationMs: Date.now() - start,
				};
			}

			messages.push({ role: "assistant", content: response.content });

			const toolResults: ClaudeContentBlock[] = [];
			for (const block of toolUseBlocks) {
				if (toolCallCount >= this.maxToolCalls) {
					// Add dummy results for remaining unprocessed tool_use blocks
					// to avoid 400 errors from the Claude API (every tool_use needs a tool_result)
					for (const remaining of toolUseBlocks.slice(toolUseBlocks.indexOf(block))) {
						toolResults.push({
							type: "tool_result",
							tool_use_id: remaining.id,
							content: "Tool call limit reached",
							is_error: true,
						});
					}
					break;
				}
				toolCallCount++;
				const result = await this.executeTool(
					block.name!,
					block.input ?? {},
				);
				toolResults.push({
					type: "tool_result",
					tool_use_id: block.id,
					content: JSON.stringify(result.output),
					is_error: result.isError,
				});

				toolCallRecords.push({
					name: block.name!,
					input: block.input ?? {},
					output: result.output,
					isError: result.isError,
				});
			}

			messages.push({ role: "user", content: toolResults });
		}

		messages.push({
			role: "user",
			content: "Summarize what you've done so far in one sentence.",
		});

		const finalResponse = await this.callClaude(messages);
		responseText =
			finalResponse.content
				.filter((b: ClaudeContentBlock) => b.type === "text")
				.map((b: ClaudeContentBlock) => b.text)
				.join(" ") || "I completed the requested actions.";

		this.maybeCompileTrace(text, toolCallRecords, responseText);

		return {
			text: responseText,
			executionPath: "claude",
			durationMs: Date.now() - start,
		};
	}

	/**
	 * After a successful Claude path, attempt to compile and index
	 * the transcript as a replayable trace for future fast-path hits.
	 */
	private maybeCompileTrace(
		utterance: string,
		toolCalls: ToolCallRecord[],
		responseText: string,
	): void {
		if (!this.traceEnabled) return;
		if (toolCalls.length === 0) return;

		const transcript: TranscriptRecord = {
			utterance,
			toolCalls,
			responseText,
		};

		const compiled = this.traceCompiler.compile(transcript);
		if (compiled) {
			this.traceIndex.insert(compiled);
		}
	}

	private buildMessages(
		text: string,
		conversationContext: string[],
		cachedState?: CachedAgentState,
	): ClaudeMessage[] {
		const messages: ClaudeMessage[] = [];

		// Add conversation history
		for (const entry of conversationContext) {
			const role = entry.startsWith("User:") ? "user" : "assistant";
			const content = entry.replace(/^(User|Assistant):\s*/, "");
			messages.push({ role, content });
		}

		// Build current user message with state context
		let userContent = text;
		if (cachedState && cachedState.workspaces.length > 0) {
			const stateContext = cachedState.workspaces
				.map(
					(ws) =>
						`${ws.workspaceName}: ${ws.agentStatus}${ws.pendingNotifications > 0 ? ` (${ws.pendingNotifications} notifications)` : ""}`,
				)
				.join("; ");
			userContent = `[Active workspaces: ${stateContext}]\n\n${text}`;
		}

		messages.push({ role: "user", content: userContent });

		return messages;
	}

	private async callClaude(messages: ClaudeMessage[]): Promise<{
		content: ClaudeContentBlock[];
		stop_reason: string;
	}> {
		const response = await fetch(
			"https://api.anthropic.com/v1/messages",
			{
				method: "POST",
				headers: {
					"x-api-key": this.apiKey,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: this.model,
					max_tokens: 300,
					system: SYSTEM_PROMPT,
					tools: toClaudeTools(),
					messages,
				}),
			},
		);

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`[voice:agent] Claude API error ${response.status}: ${body}`,
			);
		}

		return response.json();
	}

	private async executeTool(
		name: string,
		input: Record<string, unknown>,
	): Promise<{ output: unknown; isError: boolean }> {
		if (!this.tools) {
			return { output: "Tools not configured", isError: true };
		}

		try {
			// Type-safe tool dispatch
			const tools = this.tools;
			let output: unknown;

			switch (name) {
				case "listWorkspaces":
					output = await tools.listWorkspaces();
					break;
				case "listNotifications":
					output = await tools.listNotifications();
					break;
				case "getAgentStatus":
					output = await tools.getAgentStatus(input.workspaceId as string);
					break;
				case "readTerminalOutput":
					output = await tools.readTerminalOutput(
						input as { workspaceId?: string; paneId?: string; lines?: number },
					);
					break;
				case "summarizeTerminal":
					output = await tools.summarizeTerminal(
						input as { workspaceId?: string; paneId?: string },
					);
					break;
				case "focusWorkspace":
					output = await tools.focusWorkspace(input.workspaceId as string);
					break;
				case "bringToFront":
					output = await tools.bringToFront();
					break;
				case "sendText":
					output = await tools.sendText(
						input.paneId as string,
						input.text as string,
					);
					break;
				case "sendKeystroke":
					output = await tools.sendKeystroke(
						input.paneId as string,
						input.key as string,
					);
					break;
				case "createWorkspace":
					output = await tools.createWorkspace(
						input as { projectId: string; name?: string; prompt?: string },
					);
					break;
				case "closeWorkspace":
					output = await tools.closeWorkspace(input.workspaceId as string);
					break;
				case "killWorkspaceAgents":
					output = await tools.killWorkspaceAgents(
						input.workspaceId as string,
					);
					break;
				default:
					return { output: `Unknown tool: ${name}`, isError: true };
			}

			return { output, isError: false };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			console.error(`[voice:agent] Tool ${name} failed:`, message);
			return { output: message, isError: true };
		}
	}

	/**
	 * Check if a tool call requires destructive action confirmation.
	 */
	requiresConfirmation(toolName: string): boolean {
		return isDestructiveTool(toolName);
	}

	/**
	 * Get the trace index for observability and testing.
	 */
	getTraceIndex(): TraceIndex {
		return this.traceIndex;
	}

	/**
	 * Clear all cached traces.
	 */
	clearTraces(): void {
		this.traceIndex.clear();
	}

	/**
	 * Enable or disable the trace fast path at runtime.
	 * Used by the kill-switch to disable traces without rebuilding the agent.
	 */
	setTraceEnabled(enabled: boolean): void {
		this.traceEnabled = enabled;
	}
}
