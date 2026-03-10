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

		// LRU eviction if at capacity — skip if updating an existing signature
		if (!this.traces.has(trace.signature) && this.traces.size >= this.maxEntries) {
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

		// Check TTL (use defaultTtlMs as fallback if trace has no ttlMs)
		const now = Date.now();
		const ttl = trace.ttlMs || this.defaultTtlMs;
		if (now > trace.createdAt + ttl) {
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
			const ttl = trace.ttlMs || this.defaultTtlMs;
			if (now > trace.createdAt + ttl) {
				this.traces.delete(key);
			}
		}
	}

	private extractArgs(
		trace: CompiledToolTrace,
		tokens: string[],
	): Record<string, unknown> {
		const args: Record<string, unknown> = {};

		for (const binding of trace.slotBindings) {
			if (binding.source === "utterance") {
				// Find a token that looks like an identifier (not a command word)
				const candidate = tokens.find(
					(t) => t.length > 3 && !["list", "status", "focus", "stop", "send", "terminal", "workspace", "notification", "agent"].includes(t),
				);
				if (candidate) {
					args[binding.key] = candidate;
				}
			} else if (binding.source === "state_cache") {
				// State cache bindings are resolved at execution time by the guard evaluator
				// and trace runner from the cached agent state. Mark them as needing resolution
				// so the runner knows to pull from state rather than utterance tokens.
				args[binding.key] = `$${binding.key}`;
			}
		}

		return args;
	}
}
