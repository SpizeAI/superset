import {
	type VoiceAgentResponse,
	type VoiceConfig,
	VoiceAgent,
	FallbackHandler,
	VoicePipeline,
	ConversationWindow,
	AlertEvaluator,
	DEFAULT_VOICE_CONFIG,
} from "@superset/voice";
import type { CachedAgentState, ProactiveAlert } from "@superset/voice";

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

		this.running = true;

		// Initialize Claude agent if API key available
		const apiKey = this.deps.getApiKey();
		if (apiKey) {
			this.agent = new VoiceAgent({ apiKey });
		}

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

		// Forward pipeline state changes to status listeners
		this.pipeline.onEvent((event, data) => {
			if (event === "state-change") {
				const { to } = data as { from: string; to: string };
				for (const listener of this.statusListeners) {
					listener(to);
				}
			}
		});

		// Subscribe to proactive alerts
		this.unsubAlert = this.deps.onAlert((alert) => {
			this.handleAlert(alert);
		});

		// Start the pipeline
		this.pipeline.start(config.conversationTimeoutMs);

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

	toggle(): void {
		if (this.running) {
			this.stop();
		} else {
			this.start();
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

	private async handleUtterance(
		text: string,
		conversationContext: string[],
	): Promise<VoiceAgentResponse> {
		const cachedState = this.deps.getCachedState() ?? undefined;

		// Try Claude agent first, fall back to pattern matcher
		if (this.agent) {
			try {
				return await this.agent.processUtterance(
					text,
					conversationContext,
					cachedState,
				);
			} catch (error) {
				console.warn(
					"[voice:daemon] Claude agent failed, using fallback:",
					error,
				);
			}
		}

		return this.fallbackHandler.processUtterance(text, cachedState);
	}

	private handleAlert(alert: ProactiveAlert): void {
		if (!this.running) return;
		this.pipeline.handleProactiveAlert(alert);
	}
}
