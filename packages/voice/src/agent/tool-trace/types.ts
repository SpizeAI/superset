import type {
	CompiledToolTrace,
	TraceMatchResult,
	TraceRisk,
	TraceSlotBinding,
	TraceStep,
} from "../../types";

// Re-export core types for convenience within the tool-trace module
export type {
	CompiledToolTrace,
	TraceMatchResult,
	TraceRisk,
	TraceSlotBinding,
	TraceStep,
};

/**
 * Normalized utterance representation for signature matching.
 * Stripping filler words and normalizing synonyms produces a stable
 * key even when users phrase the same command differently.
 */
export interface NormalizedUtterance {
	original: string;
	normalized: string;
	tokens: string[];
}

/**
 * Guard evaluation context provided when checking trace validity.
 */
export interface GuardContext {
	cachedState: {
		workspaces: Array<{
			workspaceId: string;
			agentStatus: string;
			paneId?: string;
		}>;
	} | null;
	conversation: string[];
	resolvedArgs: Record<string, unknown>;
}

/**
 * Result of evaluating all guards for a trace.
 */
export interface GuardResult {
	ok: boolean;
	failedGuard?: string;
	reason?: string;
}

/**
 * Trace execution result after running through the trace runner.
 */
export interface TraceExecutionResult {
	success: boolean;
	output: unknown;
	stepsExecuted: number;
	error?: string;
}
