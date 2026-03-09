import type { CompiledToolTrace, TraceMatchResult } from "./types";
import { generateSignature } from "./signature";
import { normalizeUtterance } from "./utterance-normalizer";

export interface TraceIndexOptions {
	maxEntries?: number;
	defaultTtlMs?: number;
}

/**
 * In-memory trace index with TTL and LRU eviction.
 *
 * Stores compiled tool traces indexed by utterance signature.
 * Lookup is O(1) by signature hash. Eviction runs on insert
 * to keep memory bounded.
 */
export class TraceIndex {
	private traces = new Map<string, CompiledToolTrace>();
	private readonly maxEntries: number;
	private readonly defaultTtlMs: number;

	constructor(options: TraceIndexOptions = {}) {
		this.maxEntries = options.maxEntries ?? 100;
		this.defaultTtlMs = options.defaultTtlMs ?? 30 * 60 * 1_000; // 30 min
	}

	/**
	 * Insert a compiled trace into the index.
	 */
	insert(trace: CompiledToolTrace): void {
		this.evictExpired();

		// LRU eviction if at capacity
		if (this.traces.size >= this.maxEntries) {
			let oldestKey: string | null = null;
			let oldestTime = Number.POSITIVE_INFINITY;

			for (const [key, t] of this.traces) {
				if (t.lastUsedAt < oldestTime) {
					oldestTime = t.lastUsedAt;
					oldestKey = key;
				}
			}

			if (oldestKey) {
				this.traces.delete(oldestKey);
			}
		}

		this.traces.set(trace.signature, trace);
	}

	/**
	 * Match an utterance against the trace index.
	 * Returns the best match if found and not expired.
	 */
	match(
		utterance: string,
		_context: string[],
	): TraceMatchResult | null {
		const signature = generateSignature(utterance);
		const trace = this.traces.get(signature);

		if (!trace) return null;

		// Check TTL
		const now = Date.now();
		if (now > trace.createdAt + trace.ttlMs) {
			this.traces.delete(signature);
			return null;
		}

		// Update last used timestamp
		trace.lastUsedAt = now;

		// Extract args from normalized tokens
		const { tokens } = normalizeUtterance(utterance);
		const args = this.extractArgs(trace, tokens);

		return {
			trace,
			confidence: 1.0, // Exact signature match
			args,
		};
	}

	/**
	 * Remove a trace by signature.
	 */
	remove(signature: string): boolean {
		return this.traces.delete(signature);
	}

	/**
	 * Get the current size of the index.
	 */
	get size(): number {
		return this.traces.size;
	}

	/**
	 * Clear all traces.
	 */
	clear(): void {
		this.traces.clear();
	}

	private evictExpired(): void {
		const now = Date.now();
		for (const [key, trace] of this.traces) {
			if (now > trace.createdAt + trace.ttlMs) {
				this.traces.delete(key);
			}
		}
	}

	private extractArgs(
		trace: CompiledToolTrace,
		tokens: string[],
	): Record<string, unknown> {
		const args: Record<string, unknown> = {};

		// Simple extraction: look for workspace/pane identifiers in tokens
		// More sophisticated extraction would use slot bindings
		for (const binding of trace.slotBindings) {
			if (binding.source === "utterance") {
				// Find a token that looks like an identifier (not a command word)
				const candidate = tokens.find(
					(t) => t.length > 3 && !["list", "status", "focus", "stop", "send", "terminal", "workspace", "notification", "agent"].includes(t),
				);
				if (candidate) {
					args[binding.key] = candidate;
				}
			}
		}

		return args;
	}
}
