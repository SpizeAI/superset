import { randomUUID } from "node:crypto";
import type { CompiledToolTrace, TraceRisk, TraceSlotBinding, TraceStep } from "./types";
import { generateSignature } from "./signature";
import { isDestructiveTool } from "../tools";

/**
 * Compiled trace from a successful Claude tool-use transcript.
 *
 * The compiler analyzes completed tool-use conversations and extracts
 * deterministic traces that can be replayed without hitting Claude.
 * Only single-path, deterministic sequences are compiled — branching
 * or conditional tool calls are rejected.
 */

export interface ToolCallRecord {
	name: string;
	input: Record<string, unknown>;
	output: unknown;
	isError: boolean;
}

export interface TranscriptRecord {
	utterance: string;
	toolCalls: ToolCallRecord[];
	responseText: string;
}

export interface TraceCompilerOptions {
	defaultTtlMs?: number;
	maxSteps?: number;
}

export class TraceCompiler {
	private readonly defaultTtlMs: number;
	private readonly maxSteps: number;

	constructor(options: TraceCompilerOptions = {}) {
		this.defaultTtlMs = options.defaultTtlMs ?? 30 * 60 * 1_000;
		this.maxSteps = options.maxSteps ?? 5;
	}

	/**
	 * Attempt to compile a successful transcript into a replayable trace.
	 * Returns null if the transcript is non-deterministic or too complex.
	 */
	compile(transcript: TranscriptRecord): CompiledToolTrace | null {
		// Reject empty or error transcripts
		if (transcript.toolCalls.length === 0) return null;
		if (transcript.toolCalls.some((tc) => tc.isError)) return null;

		// Reject transcripts with too many steps
		if (transcript.toolCalls.length > this.maxSteps) return null;

		// Build steps from tool calls, replacing dynamic values with slot references
		const steps: TraceStep[] = transcript.toolCalls.map((tc) => ({
			tool: tc.name,
			argsTemplate: this.templatizeArgs(tc.input),
		}));

		// Determine risk level
		const risk: TraceRisk = transcript.toolCalls.some((tc) =>
			isDestructiveTool(tc.name),
		)
			? "destructive"
			: "safe";

		// Extract slot bindings from args
		const slotBindings = this.extractSlotBindings(transcript.toolCalls);

		// Determine guards
		const guards = this.inferGuards(steps, risk);

		const signature = generateSignature(transcript.utterance);
		const now = Date.now();

		return {
			id: randomUUID(),
			signature,
			createdAt: now,
			lastUsedAt: now,
			ttlMs: this.defaultTtlMs,
			risk,
			slotBindings,
			steps,
			guards,
		};
	}

	private templatizeArgs(
		input: Record<string, unknown>,
	): Record<string, unknown> {
		const SLOT_MAP: Record<string, string> = {
			workspaceId: "$workspace",
			paneId: "$pane",
		};

		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(input)) {
			result[key] = key in SLOT_MAP ? SLOT_MAP[key] : value;
		}
		return result;
	}

	private extractSlotBindings(
		toolCalls: ToolCallRecord[],
	): TraceSlotBinding[] {
		const bindings: TraceSlotBinding[] = [];
		const seenKeys = new Set<string>();

		for (const tc of toolCalls) {
			if (tc.input.workspaceId && !seenKeys.has("workspace")) {
				seenKeys.add("workspace");
				bindings.push({
					key: "workspace",
					source: "utterance",
					required: true,
				});
			}
			if (tc.input.paneId && !seenKeys.has("pane")) {
				seenKeys.add("pane");
				bindings.push({
					key: "pane",
					source: "state_cache",
					required: true,
				});
			}
		}

		return bindings;
	}

	private inferGuards(steps: TraceStep[], risk: TraceRisk): string[] {
		const guards: string[] = [];

		// Check if any step targets a workspace
		if (steps.some((s) => s.argsTemplate.workspaceId)) {
			guards.push("workspace_exists");
		}

		// Check if any step targets a pane
		if (steps.some((s) => s.argsTemplate.paneId)) {
			guards.push("pane_alive");
		}

		// Destructive traces always require confirmation
		if (risk === "destructive") {
			guards.push("requires_confirmation_token");
		}

		// Always prevent execution during active speech
		guards.push("not_while_speaking");

		return guards;
	}
}
