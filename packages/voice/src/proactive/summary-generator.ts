import type { ProactiveAlert, VoiceSourceEvent } from "../types";

export interface SummaryGeneratorOptions {
	/** Max summary length in characters */
	maxLength?: number;
}

export type SummaryProvider = (
	event: VoiceSourceEvent,
	context: SummaryContext,
) => Promise<string>;

export interface SummaryContext {
	workspaceName: string;
	agentStatus?: string;
	terminalSummary?: string;
	pendingNotifications?: number;
}

/**
 * Generates concise spoken summaries for proactive alerts.
 *
 * Uses a pluggable SummaryProvider to allow different summary strategies:
 * - Static templates (fast, no LLM call)
 * - LLM-generated summaries (richer, higher latency)
 *
 * Caches recent summaries to avoid redundant generation for rapid events.
 */
export class SummaryGenerator {
	private readonly maxLength: number;
	private provider: SummaryProvider | null = null;
	private cache = new Map<string, { text: string; expiresAt: number }>();
	private readonly cacheTtlMs = 60_000;

	constructor(options: SummaryGeneratorOptions = {}) {
		this.maxLength = options.maxLength ?? 200;
	}

	setProvider(provider: SummaryProvider): void {
		this.provider = provider;
	}

	/**
	 * Generate a spoken summary for an event.
	 * Falls back to static template if no provider is set.
	 */
	async generate(
		event: VoiceSourceEvent,
		context: SummaryContext,
	): Promise<string> {
		const cacheKey = `${event.eventId}`;
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() < cached.expiresAt) {
			return cached.text;
		}

		let summary: string;
		if (this.provider) {
			try {
				summary = await this.provider(event, context);
			} catch (error) {
				console.warn(
					"[voice:summary] Provider failed, using static template:",
					error,
				);
				summary = this.staticSummary(event, context);
			}
		} else {
			summary = this.staticSummary(event, context);
		}

		// Truncate if too long
		if (summary.length > this.maxLength) {
			summary = `${summary.slice(0, this.maxLength - 3)}...`;
		}

		this.cache.set(cacheKey, {
			text: summary,
			expiresAt: Date.now() + this.cacheTtlMs,
		});

		return summary;
	}

	/**
	 * Pre-generate a summary on proactive event arrival for low-latency alerts.
	 * Stores in cache for immediate retrieval when the alert is delivered.
	 */
	async preGenerate(
		event: VoiceSourceEvent,
		context: SummaryContext,
	): Promise<string> {
		return this.generate(event, context);
	}

	/**
	 * Build an enriched ProactiveAlert with a generated summary.
	 */
	async enrichAlert(
		alert: ProactiveAlert,
		event: VoiceSourceEvent,
		context: SummaryContext,
	): Promise<ProactiveAlert> {
		const summary = await this.generate(event, context);
		return { ...alert, summary };
	}

	clearCache(): void {
		this.cache.clear();
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	private staticSummary(
		event: VoiceSourceEvent,
		context: SummaryContext,
	): string {
		const name = context.workspaceName;

		switch (event.kind) {
			case "agent-state":
				return `${name} agent has completed.`;
			case "permission-request":
				return `${name} needs your permission to continue.`;
			case "agent-error":
				return `${name} agent encountered an error.`;
			case "terminal-exit":
				return `Terminal session ended in ${name}.`;
		}
	}
}
