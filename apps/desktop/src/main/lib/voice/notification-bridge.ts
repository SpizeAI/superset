import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { NOTIFICATION_EVENTS } from "shared/constants";
import type { AgentLifecycleEvent } from "shared/notification-types";
import type { ProactiveAlert, VoiceSourceEvent } from "@superset/voice";
import { notificationsEmitter } from "../notifications/server";
import { getDaemonTerminalManager } from "../terminal";

/**
 * Bridges Superset's notification system to the voice alert pipeline.
 *
 * Listens to two event sources:
 * 1. `notificationsEmitter` (agent lifecycle: Start, Stop, PermissionRequest)
 * 2. `DaemonTerminalManager` terminalExit events
 *
 * Converts raw events into VoiceSourceEvents and ProactiveAlerts,
 * then forwards them to the voice daemon's alert evaluator.
 */
export class NotificationBridge extends EventEmitter {
	private handlers: Array<() => void> = [];
	private started = false;
	private workspaceNameResolver: (workspaceId: string) => string;

	constructor(
		workspaceNameResolver: (workspaceId: string) => string = (id) => id,
	) {
		super();
		this.workspaceNameResolver = workspaceNameResolver;
	}

	start(): void {
		if (this.started) return;
		this.started = true;

		// Listen for agent lifecycle events
		const onLifecycle = (event: AgentLifecycleEvent) => {
			this.handleAgentLifecycle(event);
		};
		notificationsEmitter.on(
			NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
			onLifecycle,
		);
		this.handlers.push(() => {
			notificationsEmitter.off(
				NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
				onLifecycle,
			);
		});

		// Listen for terminal exit events
		try {
			const terminal = getDaemonTerminalManager();
			const onExit = (data: {
				paneId: string;
				exitCode: number;
				signal?: number;
			}) => {
				this.handleTerminalExit(data);
			};
			terminal.on("terminalExit", onExit);
			this.handlers.push(() => {
				terminal.off("terminalExit", onExit);
			});
		} catch {
			// Terminal manager may not be initialized yet
			console.warn(
				"[voice:bridge] Terminal manager not available, exit events won't be captured",
			);
		}

		console.log("[voice:bridge] Started listening for events");
	}

	stop(): void {
		for (const cleanup of this.handlers) {
			cleanup();
		}
		this.handlers = [];
		this.started = false;
		console.log("[voice:bridge] Stopped");
	}

	private handleAgentLifecycle(event: AgentLifecycleEvent): void {
		const sourceEvent: VoiceSourceEvent = {
			kind: this.mapEventKind(event.eventType),
			eventId: randomUUID(),
			paneId: event.paneId,
			workspaceId: event.workspaceId,
			receivedAt: Date.now(),
		};

		this.emit("source-event", sourceEvent);

		// Generate proactive alert for specific event types
		const alert = this.toProactiveAlert(event, sourceEvent.eventId);
		if (alert) {
			this.emit("alert", alert);
		}
	}

	private handleTerminalExit(data: {
		paneId: string;
		exitCode: number;
		signal?: number;
	}): void {
		const sourceEvent: VoiceSourceEvent = {
			kind: "terminal-exit",
			eventId: randomUUID(),
			paneId: data.paneId,
			receivedAt: Date.now(),
		};

		this.emit("source-event", sourceEvent);
	}

	private mapEventKind(
		eventType: AgentLifecycleEvent["eventType"],
	): VoiceSourceEvent["kind"] {
		switch (eventType) {
			case "Start":
			case "Stop":
				return "agent-state";
			case "PermissionRequest":
				return "permission-request";
			default:
				return "agent-state";
		}
	}

	private toProactiveAlert(
		event: AgentLifecycleEvent,
		sourceEventId: string,
	): ProactiveAlert | null {
		if (!event.workspaceId) return null;

		const workspaceName = this.workspaceNameResolver(event.workspaceId);

		switch (event.eventType) {
			case "Stop":
				return {
					type: "agent-complete",
					workspaceId: event.workspaceId,
					workspaceName,
					summary: `${workspaceName} agent has finished.`,
					priority: "normal",
					sourceEventId,
				};
			case "PermissionRequest":
				return {
					type: "permission-request",
					workspaceId: event.workspaceId,
					workspaceName,
					summary: `${workspaceName} needs your permission to continue.`,
					priority: "high",
					sourceEventId,
				};
			default:
				return null;
		}
	}
}
