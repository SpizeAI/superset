import {
	type VoiceAgentResponse,
	type VoiceConfig,
	type ExecutionPath,
	VoiceAgent,
	FallbackHandler,
	VoicePipeline,
	ConversationWindow,
	AlertEvaluator,
	DEFAULT_VOICE_CONFIG,
} from "@superset/voice";
import type { CachedAgentState, ProactiveAlert } from "@superset/voice";

export interface TraceMetrics {
	traceHits: number;
	traceMisses: number;
	guardFailures: number;
	traceErrors: number;
	claudeFallbacks: number;
	totalRequests: number;
}

export interface VoiceDaemonDeps {
	getConfig: () => VoiceConfig;
	getApiKey: () => string | null;
	getCachedState: () => CachedAgentState | null;
	onAlert: (handler: (alert: ProactiveAlert) => void) => () => void;
	speak: (text: string) => Promise<void>;
	speakStreaming: (sentence: string) => Promise<void>;
	cancel: () => void;
	onWakeDetected: (handler: () => void) => () => void;
	onSpeechEnd: (handler: () => void) => () => void;
	transcribe: () => Promise<string>;
}

/**
 * Process-scoped voice daemon.
 *
 * Manages the lifecycle of the entire voice system from app init to before-quit.
 * This is independent of window lifecycle — voice continues working even if all
 * windows are closed (macOS dock mode). The daemon coordinates:
 * - The voice pipeline state machine
 * - The conversation window for follow-ups
 * - The alert evaluator for proactive alerts
 * - The voice agent for Claude tool-use
 * - The fallback handler for offline mode
 */
export class VoiceDaemon {
	private pipeline: VoicePipeline;
	private conversationWindow: ConversationWindow;
	private alertEvaluator: AlertEvaluator;
	private agent: VoiceAgent | null = null;
	private fallbackHandler: FallbackHandler;
	private deps: VoiceDaemonDeps;
	private running = false;
	private unsubAlert: (() => void) | null = null;
	private statusListeners: Array<(state: string) => void> = [];
	private traceKillSwitch = false;
	private metrics: TraceMetrics = {
		traceHits: 0,
		traceMisses: 0,
		guardFailures: 0,
		traceErrors: 0,
		claudeFallbacks: 0,
		totalRequests: 0,
	};

	constructor(deps: VoiceDaemonDeps) {
		this.deps = deps;
		this.pipeline = new VoicePipeline();
		this.conversationWindow = new ConversationWindow();
		this.alertEvaluator = new AlertEvaluator();
		this.fallbackHandler = new FallbackHandler();
	}

	async start(): Promise<void> {
		if (this.running) return;

		const config = this.deps.getConfig();
		if (!config.enabled) {
			console.log("[voice:daemon] Voice control disabled in config");
			return;
		}

		// Initialize Claude agent if API key available
		const apiKey = this.deps.getApiKey();
		if (apiKey) {
			this.agent = new VoiceAgent({
				apiKey,
				traceEnabled: config.voiceTraceEnabled && !this.traceKillSwitch,
				traceMaxEntries: config.voiceTraceMaxEntries,
				traceTtlMs: config.voiceTraceTtlMs,
			});
		}

		try {
			// Wire pipeline dependencies
			this.pipeline.init({
				onWakeDetected: this.deps.onWakeDetected,
				onSpeechEnd: this.deps.onSpeechEnd,
				transcribe: this.deps.transcribe,
				processUtterance: (text, context) =>
					this.handleUtterance(text, context),
				speak: this.deps.speak,
				speakStreaming: this.deps.speakStreaming,
				cancel: this.deps.cancel,
			});

			// Start the pipeline
			this.pipeline.start(config.conversationTimeoutMs);
		} catch (error) {
			this.agent = null;
			throw error;
		}

		this.running = true;

		// Forward pipeline state changes and track trace metrics
		this.pipeline.onEvent((event, data) => {
			if (event === "state-change") {
				const { to } = data as { from: string; to: string };
				for (const listener of this.statusListeners) {
					listener(to);
				}
			}
			if (event === "response-ready") {
				const response = data as VoiceAgentResponse;
				console.log(
					`[voice:daemon] Response via ${response.executionPath} in ${response.durationMs}ms` +
						(response.traceId ? ` (trace: ${response.traceId})` : ""),
				);
			}
		});

		// Subscribe to proactive alerts
		this.unsubAlert = this.deps.onAlert((alert) => {
			this.handleAlert(alert);
		});

		console.log("[voice:daemon] Started");
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;

		this.pipeline.stop();
		this.conversationWindow.close();
		this.unsubAlert?.();
		this.unsubAlert = null;

		console.log("[voice:daemon] Stopped");
	}

	async toggle(): Promise<void> {
		if (this.running) {
			this.stop();
		} else {
			await this.start();
		}
	}

	isRunning(): boolean {
		return this.running;
	}

	getState(): string {
		return this.pipeline.getState();
	}

	onStatusChange(handler: (state: string) => void): () => void {
		this.statusListeners.push(handler);
		return () => {
			this.statusListeners = this.statusListeners.filter(
				(h) => h !== handler,
			);
		};
	}

	/**
	 * Get current trace metrics for observability.
	 */
	getMetrics(): TraceMetrics {
		return { ...this.metrics };
	}

	/**
	 * Enable/disable the trace kill-switch.
	 * When enabled, all utterances go through Claude regardless of trace matches.
	 */
	setTraceKillSwitch(disabled: boolean): void {
		this.traceKillSwitch = disabled;
		if (disabled) {
			console.warn("[voice:daemon] Trace kill-switch activated — Claude-only mode");
			this.agent?.clearTraces();
		} else {
			console.log("[voice:daemon] Trace kill-switch deactivated — traces re-enabled");
		}
	}

	isTraceKillSwitchActive(): boolean {
		return this.traceKillSwitch;
	}

	private async handleUtterance(
		text: string,
		conversationContext: string[],
	): Promise<VoiceAgentResponse> {
		this.metrics.totalRequests++;
		const cachedState = this.deps.getCachedState() ?? undefined;

		// Try Claude agent first, fall back to pattern matcher
		if (this.agent) {
			try {
				const response = await this.agent.processUtterance(
					text,
					conversationContext,
					cachedState,
				);
				this.recordExecutionPath(response.executionPath);
				return response;
			} catch (error) {
				console.warn(
					"[voice:daemon] Claude agent failed, using fallback:",
					error,
				);
			}
		}

		const response = await this.fallbackHandler.processUtterance(text, cachedState);
		this.recordExecutionPath(response.executionPath);
		return response;
	}

	private recordExecutionPath(path: ExecutionPath): void {
		switch (path) {
			case "trace":
				this.metrics.traceHits++;
				break;
			case "claude":
				this.metrics.traceMisses++;
				break;
			case "fallback":
				this.metrics.claudeFallbacks++;
				break;
		}
	}

	private handleAlert(alert: ProactiveAlert): void {
		if (!this.running) return;
		this.pipeline.handleProactiveAlert(alert);
	}
}
