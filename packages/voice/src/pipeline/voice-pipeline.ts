import { VOICE_CONSTANTS } from "../config";
import type {
	ProactiveAlert,
	VoiceAgentResponse,
	VoiceLatencyEvent,
	VoicePipelineState,
} from "../types";
import {
	ConversationWindow,
	isAffirmativeUtterance,
	type PendingIntent,
} from "./conversation-window";

export type PipelineEventType =
	| "state-change"
	| "transcript-ready"
	| "response-ready"
	| "error"
	| "latency";

export type PipelineEventHandler = (
	event: PipelineEventType,
	data: unknown,
) => void;

export interface VoicePipelineDeps {
	onWakeDetected: (handler: () => void) => () => void;
	onSpeechEnd: (handler: () => void) => () => void;
	transcribe: () => Promise<string>;
	processUtterance: (
		text: string,
		conversationContext: string[],
	) => Promise<VoiceAgentResponse>;
	speak: (text: string) => Promise<void>;
	speakStreaming: (sentence: string) => Promise<void>;
	cancel: () => void;
	executeConfirmedTrace?: (intent: PendingIntent) => Promise<VoiceAgentResponse>;
}

/**
 * Core voice pipeline state machine.
 *
 * Manages transitions between idle, wake detection, command capture,
 * transcription, thinking, speaking, and conversational follow-up states.
 * Each cycle gets a unique ID for cancellation. Errors reset to wake mode.
 *
 * The pipeline enforces strict state ordering to prevent race conditions:
 * - Only one cycle can be active at a time
 * - Wake detection and conversational follow-ups share the same think/speak path
 * - Proactive alerts bypass wake detection and go straight to speaking
 */
export class VoicePipeline {
	private state: VoicePipelineState = "idle";
	private cycleId = 0;
	private handlers: PipelineEventHandler[] = [];
	private conversationContext: string[] = [];
	private conversationExchanges = 0;
	private unsubWake: (() => void) | null = null;
	private unsubSpeech: (() => void) | null = null;
	private deps: VoicePipelineDeps | null = null;
	private conversationTimer: ReturnType<typeof setTimeout> | null = null;
	private conversationTimeoutMs = VOICE_CONSTANTS.VAD_SILENCE_WAKE_MS * 5;
	private readonly confirmationWindow = new ConversationWindow();

	onEvent(handler: PipelineEventHandler): () => void {
		this.handlers.push(handler);
		return () => {
			this.handlers = this.handlers.filter((h) => h !== handler);
		};
	}

	getState(): VoicePipelineState {
		return this.state;
	}

	init(deps: VoicePipelineDeps): void {
		this.deps = deps;
	}

	start(conversationTimeoutMs?: number): void {
		if (!this.deps) throw new Error("[voice:pipeline] Not initialized");
		if (conversationTimeoutMs) {
			this.conversationTimeoutMs = conversationTimeoutMs;
		}
		this.transitionTo("listening-for-wake");
		this.bindWakeDetection();
	}

	stop(): void {
		this.cancelCurrentCycle();
		this.unbindAll();
		this.clearConversationTimer();
		this.conversationContext = [];
		this.conversationExchanges = 0;
		this.transitionTo("idle");
	}

	/**
	 * Inject a proactive alert directly into the speaking state,
	 * bypassing wake detection. After speaking, opens conversational window.
	 */
	async handleProactiveAlert(alert: ProactiveAlert): Promise<void> {
		if (!this.deps) return;
		if (this.state === "speaking" || this.state === "thinking") return;

		this.deps.cancel();
		const cycle = this.newCycle();

		this.transitionTo("speaking");
		try {
			await this.deps.speak(alert.summary);
			if (this.isCycleCurrent(cycle)) {
				this.openConversationalWindow();
			}
		} catch (error) {
			this.handleError(error, cycle);
		}
	}

	private bindWakeDetection(): void {
		if (!this.deps) return;
		this.unsubWake = this.deps.onWakeDetected(() => {
			this.handleWakeDetected();
		});
	}

	private async handleWakeDetected(): Promise<void> {
		if (!this.deps) return;
		const cycle = this.newCycle();

		this.transitionTo("listening-for-command");

		this.unsubSpeech = this.deps.onSpeechEnd(() => {
			if (this.isCycleCurrent(cycle)) {
				this.handleSpeechEnd(cycle);
			}
		});
	}

	private async handleSpeechEnd(cycle: number): Promise<void> {
		if (!this.deps || !this.isCycleCurrent(cycle)) return;

		const latency: Partial<VoiceLatencyEvent> = {
			captureEndMs: Date.now(),
		};

		this.transitionTo("transcribing");

		try {
			const text = await this.deps.transcribe();
			if (!this.isCycleCurrent(cycle) || !text.trim()) {
				this.returnToListening();
				return;
			}

			latency.sttFinalMs = Date.now();
			this.emit("transcript-ready", text);

			// ── Check for pending destructive confirmation ───────────────
			const pendingConfirmation = this.tryConfirmDestructive(text);
			if (pendingConfirmation !== undefined) {
				if (!this.isCycleCurrent(cycle)) return;

				if (pendingConfirmation) {
					const response = pendingConfirmation;
					this.transitionTo("speaking");
					await this.deps.speak(response.text);
					this.emit("response-ready", response);
					this.conversationContext.push(`User: ${text}`);
					this.conversationContext.push(`Assistant: ${response.text}`);
					this.conversationExchanges++;
					if (this.isCycleCurrent(cycle)) {
						this.openConversationalWindow();
					}
				} else {
					this.transitionTo("speaking");
					await this.deps.speak("Cancelled.");
					this.conversationContext.push(`User: ${text}`);
					this.conversationContext.push("Assistant: Cancelled.");
					this.confirmationWindow.clearPendingIntent();
					this.openConversationalWindow();
				}
				return;
			}

			// ── Normal processing path ──────────────────────────────────
			this.transitionTo("thinking");
			const response = await this.deps.processUtterance(
				text,
				this.conversationContext,
			);

			if (!this.isCycleCurrent(cycle)) return;

			latency.llmFirstTokenMs = Date.now();

			this.transitionTo("speaking");
			latency.ttsFirstAudioMs = Date.now();
			await this.deps.speak(response.text);

			latency.playbackStartMs = Date.now();
			this.emit("latency", latency);
			this.emit("response-ready", response);

			// Update conversation context
			this.conversationContext.push(`User: ${text}`);
			this.conversationContext.push(`Assistant: ${response.text}`);
			this.conversationExchanges++;

			if (
				this.isCycleCurrent(cycle) &&
				this.conversationExchanges < VOICE_CONSTANTS.MAX_CONVERSATION_EXCHANGES
			) {
				this.openConversationalWindow();
			} else {
				this.returnToListening();
			}
		} catch (error) {
			this.handleError(error, cycle);
		}
	}

	/**
	 * Check if the utterance is a confirmation/denial of a pending
	 * destructive trace. Returns:
	 * - VoiceAgentResponse if confirmed and executed
	 * - null if denied (user said no)
	 * - undefined if no pending intent exists (normal flow)
	 */
	private tryConfirmDestructive(
		text: string,
	): Promise<VoiceAgentResponse> | null | undefined {
		if (!this.confirmationWindow.hasPendingIntent()) return undefined;

		const intent = this.confirmationWindow.getPendingIntent();
		if (!intent) return undefined;

		if (isAffirmativeUtterance(text)) {
			const confirmed = this.confirmationWindow.confirmIntent(intent.token);
			if (confirmed && this.deps?.executeConfirmedTrace) {
				return this.deps.executeConfirmedTrace(confirmed);
			}
			return null;
		}

		// Non-affirmative response to a pending intent = denial
		return null;
	}

	/**
	 * Register a pending destructive trace intent.
	 * Called by the voice daemon when a destructive trace match is found.
	 */
	setPendingTraceIntent(
		traceId: string,
		action: string,
		args: Record<string, unknown>,
	): PendingIntent {
		return this.confirmationWindow.createTraceIntent(traceId, action, args);
	}

	/**
	 * Open a conversational window where follow-up utterances don't need
	 * the wake word. Times out after conversationTimeoutMs of silence.
	 */
	private openConversationalWindow(): void {
		this.transitionTo("conversational");
		this.clearConversationTimer();

		// Listen for follow-up speech without wake word
		if (this.deps) {
			this.unsubSpeech = this.deps.onSpeechEnd(() => {
				this.clearConversationTimer();
				const cycle = this.newCycle();
				this.handleSpeechEnd(cycle);
			});
		}

		this.conversationTimer = setTimeout(() => {
			this.returnToListening();
		}, this.conversationTimeoutMs);
	}

	private returnToListening(): void {
		this.unbindSpeech();
		this.clearConversationTimer();
		this.conversationContext = [];
		this.conversationExchanges = 0;
		this.confirmationWindow.clearPendingIntent();
		this.transitionTo("listening-for-wake");
		this.bindWakeDetection();
	}

	private handleError(error: unknown, cycle: number): void {
		if (!this.isCycleCurrent(cycle)) return;
		console.error("[voice:pipeline] Error:", error);
		this.emit("error", error);
		this.returnToListening();
	}

	private transitionTo(newState: VoicePipelineState): void {
		const prev = this.state;
		this.state = newState;
		this.emit("state-change", { from: prev, to: newState });
	}

	private newCycle(): number {
		return ++this.cycleId;
	}

	private isCycleCurrent(cycle: number): boolean {
		return cycle === this.cycleId;
	}

	private cancelCurrentCycle(): void {
		this.cycleId++;
		this.deps?.cancel();
	}

	private unbindAll(): void {
		this.unbindWake();
		this.unbindSpeech();
	}

	private unbindWake(): void {
		this.unsubWake?.();
		this.unsubWake = null;
	}

	private unbindSpeech(): void {
		this.unsubSpeech?.();
		this.unsubSpeech = null;
	}

	private clearConversationTimer(): void {
		if (this.conversationTimer) {
			clearTimeout(this.conversationTimer);
			this.conversationTimer = null;
		}
	}

	private emit(event: PipelineEventType, data: unknown): void {
		for (const handler of this.handlers) {
			handler(event, data);
		}
	}
}
