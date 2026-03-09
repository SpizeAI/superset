import { VOICE_CONSTANTS } from "../config";
import type { AlertPriority, ProactiveAlert, VoiceSourceEvent } from "../types";

export interface AlertEvaluatorOptions {
	cooldownMs?: number;
	/** Suppress all alerts when true (Do Not Disturb) */
	dndEnabled?: boolean;
	/** Maximum alerts to batch before forcing delivery */
	maxBatchSize?: number;
	/** Time window for batching consecutive events (ms) */
	batchWindowMs?: number;
}

export type AlertHandler = (alert: ProactiveAlert) => void;

/**
 * Evaluates incoming source events and decides which become spoken alerts.
 *
 * Policies:
 * 1. **Cooldown**: Same-type events from the same workspace are suppressed
 *    within the cooldown window (default 30s).
 * 2. **Priority interrupt**: High-priority events (permission requests) bypass
 *    cooldown and interrupt the current alert.
 * 3. **DND suppression**: All alerts suppressed when DND is enabled.
 * 4. **Dedupe**: Events with the same eventId are never processed twice.
 * 5. **Batch merge**: Multiple agent-complete events within the batch window
 *    are merged into a single spoken summary.
 */
export class AlertEvaluator {
	private handlers: AlertHandler[] = [];
	private seenEventIds = new Set<string>();
	private cooldowns = new Map<string, number>();
	private pendingBatch: VoiceSourceEvent[] = [];
	private batchTimer: ReturnType<typeof setTimeout> | null = null;

	private readonly cooldownMs: number;
	private dndEnabled: boolean;
	private readonly maxBatchSize: number;
	private readonly batchWindowMs: number;

	// Metrics
	private acceptedCount = 0;
	private suppressedCount = 0;

	constructor(options: AlertEvaluatorOptions = {}) {
		this.cooldownMs = options.cooldownMs ?? VOICE_CONSTANTS.ALERT_COOLDOWN_MS;
		this.dndEnabled = options.dndEnabled ?? false;
		this.maxBatchSize = options.maxBatchSize ?? 5;
		this.batchWindowMs = options.batchWindowMs ?? 3_000;
	}

	onAlert(handler: AlertHandler): () => void {
		this.handlers.push(handler);
		return () => {
			this.handlers = this.handlers.filter((h) => h !== handler);
		};
	}

	setDnd(enabled: boolean): void {
		this.dndEnabled = enabled;
	}

	/**
	 * Evaluate a source event. May emit an alert immediately (high priority),
	 * batch it for later delivery, or suppress it entirely.
	 */
	evaluate(
		event: VoiceSourceEvent,
		workspaceName: string,
	): void {
		// DND suppresses everything
		if (this.dndEnabled) {
			this.suppressedCount++;
			return;
		}

		// Dedupe by eventId
		if (this.seenEventIds.has(event.eventId)) {
			this.suppressedCount++;
			return;
		}
		this.seenEventIds.add(event.eventId);

		// Determine priority
		const priority = this.classifyPriority(event);

		// High-priority events bypass cooldown and batch
		if (priority === "high") {
			this.flushBatch();
			this.emitAlert(this.buildAlert(event, workspaceName, priority));
			return;
		}

		// Check cooldown for normal-priority events
		const cooldownKey = `${event.workspaceId}:${event.kind}`;
		const lastEmitted = this.cooldowns.get(cooldownKey);
		if (lastEmitted && Date.now() - lastEmitted < this.cooldownMs) {
			this.suppressedCount++;
			return;
		}

		// Add to batch for merge
		this.pendingBatch.push(event);

		if (this.pendingBatch.length >= this.maxBatchSize) {
			this.flushBatch();
		} else if (!this.batchTimer) {
			this.batchTimer = setTimeout(() => {
				this.flushBatch();
			}, this.batchWindowMs);
		}
	}

	/**
	 * Force-flush any pending batched events into a merged alert.
	 */
	flushBatch(): void {
		if (this.batchTimer) {
			clearTimeout(this.batchTimer);
			this.batchTimer = null;
		}

		if (this.pendingBatch.length === 0) return;

		const events = this.pendingBatch.splice(0);

		if (events.length === 1) {
			const event = events[0];
			this.emitAlert(
				this.buildAlert(event, this.resolveWorkspaceName(event), "normal"),
			);
		} else {
			// Merge into a single batch alert
			const workspaceNames = [
				...new Set(events.map((e) => this.resolveWorkspaceName(e))),
			];
			const alert: ProactiveAlert = {
				type: "agent-complete",
				workspaceId: events[0].workspaceId ?? "",
				workspaceName: workspaceNames.join(", "),
				summary: `${events.length} agents completed in ${workspaceNames.length === 1 ? workspaceNames[0] : `${workspaceNames.length} workspaces`}.`,
				priority: "normal",
				sourceEventId: events.map((e) => e.eventId).join(","),
			};
			this.emitAlert(alert);
		}
	}

	getMetrics(): { accepted: number; suppressed: number } {
		return {
			accepted: this.acceptedCount,
			suppressed: this.suppressedCount,
		};
	}

	reset(): void {
		this.seenEventIds.clear();
		this.cooldowns.clear();
		this.pendingBatch = [];
		if (this.batchTimer) {
			clearTimeout(this.batchTimer);
			this.batchTimer = null;
		}
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	private classifyPriority(event: VoiceSourceEvent): AlertPriority {
		if (event.kind === "permission-request") return "high";
		if (event.kind === "agent-error") return "high";
		return "normal";
	}

	private buildAlert(
		event: VoiceSourceEvent,
		workspaceName: string,
		priority: AlertPriority,
	): ProactiveAlert {
		return {
			type: this.mapEventKindToAlertType(event.kind),
			workspaceId: event.workspaceId ?? "",
			workspaceName,
			summary: this.generateSummary(event, workspaceName),
			priority,
			sourceEventId: event.eventId,
		};
	}

	private mapEventKindToAlertType(
		kind: VoiceSourceEvent["kind"],
	): ProactiveAlert["type"] {
		switch (kind) {
			case "agent-state":
				return "agent-complete";
			case "permission-request":
				return "permission-request";
			case "agent-error":
			case "terminal-exit":
				return "agent-error";
		}
	}

	private generateSummary(
		event: VoiceSourceEvent,
		workspaceName: string,
	): string {
		switch (event.kind) {
			case "agent-state":
				return `${workspaceName} agent has completed.`;
			case "permission-request":
				return `${workspaceName} needs your permission to continue.`;
			case "agent-error":
				return `${workspaceName} agent encountered an error.`;
			case "terminal-exit":
				return `Terminal session ended in ${workspaceName}.`;
		}
	}

	private emitAlert(alert: ProactiveAlert): void {
		const cooldownKey = `${alert.workspaceId}:${alert.type}`;
		this.cooldowns.set(cooldownKey, Date.now());
		this.acceptedCount++;

		for (const handler of this.handlers) {
			handler(alert);
		}
	}

	// Workspace name resolution is done by the caller via the evaluate() parameter.
	// This fallback handles batch-merge where we only have the event.
	private workspaceNameCache = new Map<string, string>();

	private resolveWorkspaceName(event: VoiceSourceEvent): string {
		return (
			this.workspaceNameCache.get(event.workspaceId ?? "") ??
			event.workspaceId ??
			"Unknown workspace"
		);
	}
}
