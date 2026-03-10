import {
	type VoiceConfig,
	DEFAULT_VOICE_CONFIG,
	MicrophoneCapture,
	PorcupineDetector,
	VoiceActivityDetector,
	WhisperTranscriber,
	ElevenLabsSpeaker,
	MacOsFallbackSpeaker,
} from "@superset/voice";
import { workspaces, settings } from "@superset/local-db";
import { isNull } from "drizzle-orm";
import { getCredentialsFromAnySource } from "@superset/chat/host";
import { localDb } from "../local-db";
import { appState } from "../app-state";
import { VoiceDaemon } from "./voice-daemon";
import { VoiceStateCache } from "./state-cache";
import { NotificationBridge } from "./notification-bridge";
import { TerminalReader } from "./terminal-reader";
import { getElevenLabsApiKey, getPicovoiceAccessKey } from "./voice-secrets";
import { BrowserWindow } from "electron";
import { emitVoiceStatus } from "./status-bus";
import { createVoiceActions } from "./voice-actions";
import { OpenWakeWordSidecar } from "./wake-word/openwakeword-sidecar";

let daemon: VoiceDaemon | null = null;
let stateCache: VoiceStateCache | null = null;
let notificationBridge: NotificationBridge | null = null;
let terminalReader: TerminalReader | null = null;
let microphone: MicrophoneCapture | null = null;
let wakeDetector: PorcupineDetector | OpenWakeWordSidecar | null = null;
let vad: VoiceActivityDetector | null = null;
let transcriber: WhisperTranscriber | null = null;
let ttsSpeaker: ElevenLabsSpeaker | MacOsFallbackSpeaker | null = null;
let runtimeStarted = false;
let warnedNoWakeWordFallback = false;
let runtimeTransitionQueue: Promise<void> = Promise.resolve();

function getVoiceConfig(): VoiceConfig {
	const row = localDb.select().from(settings).get();
	if (!row) return DEFAULT_VOICE_CONFIG;

	return {
		...DEFAULT_VOICE_CONFIG,
		enabled: row.voiceEnabled ?? DEFAULT_VOICE_CONFIG.enabled,
		proactiveAlerts:
			row.voiceProactiveAlerts ?? DEFAULT_VOICE_CONFIG.proactiveAlerts,
		ttsProvider:
			(row.voiceTtsProvider as VoiceConfig["ttsProvider"]) ??
			DEFAULT_VOICE_CONFIG.ttsProvider,
		sttMode:
			(row.voiceSttMode as VoiceConfig["sttMode"]) ??
			DEFAULT_VOICE_CONFIG.sttMode,
		whisperModel:
			(row.voiceWhisperModel as VoiceConfig["whisperModel"]) ??
			DEFAULT_VOICE_CONFIG.whisperModel,
		wakeWordSensitivity:
			row.voiceWakeWordSensitivity ??
			DEFAULT_VOICE_CONFIG.wakeWordSensitivity,
		micDeviceIndex:
			row.voiceMicDeviceIndex ?? DEFAULT_VOICE_CONFIG.micDeviceIndex,
		conversationTimeoutMs:
			row.voiceConversationTimeoutMs ??
			DEFAULT_VOICE_CONFIG.conversationTimeoutMs,
		commandTimeoutMs:
			row.voiceCommandTimeoutMs ?? DEFAULT_VOICE_CONFIG.commandTimeoutMs,
		voiceTraceEnabled:
			row.voiceTraceEnabled ?? DEFAULT_VOICE_CONFIG.voiceTraceEnabled,
	};
}

function getAnthropicApiKey(): string | null {
	const creds = getCredentialsFromAnySource();
	if (creds) return creds.apiKey;
	return process.env.ANTHROPIC_API_KEY ?? null;
}

async function getWorkspaceList() {
	return localDb
		.select()
		.from(workspaces)
		.where(isNull(workspaces.deletingAt))
		.all()
		.map((ws) => ({
			id: ws.id,
			name: ws.name,
			agentStatus: "idle" as string,
			pendingNotifications: 0,
			branchName: undefined as string | undefined,
		}));
}

function resolveWorkspaceName(workspaceId: string): string {
	const ws = localDb
		.select()
		.from(workspaces)
		.where(isNull(workspaces.deletingAt))
		.all()
		.find((w) => w.id === workspaceId);
	return ws?.name ?? workspaceId;
}

function resolvePaneId(workspaceId: string): string | null {
	const tabsData = appState.data.tabsState;
	const activeTabId = tabsData.activeTabIds[workspaceId];
	if (!activeTabId) return null;

	const focusedPaneId = tabsData.focusedPaneIds[activeTabId];
	if (focusedPaneId) return focusedPaneId;

	// Find any pane belonging to the active tab
	for (const [paneId, pane] of Object.entries(tabsData.panes)) {
		if (pane.tabId === activeTabId) return paneId;
	}
	return null;
}

/**
 * Resolve which wake engine to actually use based on config and available keys.
 * Falls through: porcupine → openwakeword → vad_fallback.
 */
function resolveWakeEngine(
	preferred: import("@superset/voice").WakeEngine,
	picovoiceKey: string | null,
): import("@superset/voice").WakeEngine {
	if (preferred === "porcupine" && picovoiceKey) return "porcupine";
	if (preferred === "porcupine" && !picovoiceKey) {
		console.warn("[voice:init] Porcupine requested but no key — falling back to openwakeword");
		return "openwakeword";
	}
	if (preferred === "openwakeword") return "openwakeword";
	return "vad_fallback";
}

async function configureRuntimeComponents(config: VoiceConfig): Promise<void> {
	// Ensure previous runtime components are fully released before reconfiguration.
	await microphone?.stop();
	await wakeDetector?.release();
	ttsSpeaker?.cancel();
	transcriber?.reset();

	microphone = new MicrophoneCapture({ deviceIndex: config.micDeviceIndex });
	vad = new VoiceActivityDetector();
	warnedNoWakeWordFallback = false;

	try {
		const { PvRecorder } = await import("@picovoice/pvrecorder-node");
		const devices: string[] = PvRecorder.getAvailableDevices();
		const selectedDeviceName =
			config.micDeviceIndex === -1
				? "System Default"
				: (devices[config.micDeviceIndex] ??
					`Unknown device index ${config.micDeviceIndex}`);
		console.log(
			`[voice:init] Microphone configured: ${selectedDeviceName} (index ${config.micDeviceIndex})`,
		);
	} catch {
		console.log(
			`[voice:init] Microphone configured with index ${config.micDeviceIndex}`,
		);
	}

	// Wake word detector — engine selection with fallback chain:
	// porcupine (if key present) → openwakeword (sidecar) → vad_fallback
	const picovoiceKey =
		getPicovoiceAccessKey() ?? process.env.PICOVOICE_ACCESS_KEY ?? null;
	const resolvedWakeEngine = resolveWakeEngine(config.wakeEngine, picovoiceKey);

	if (resolvedWakeEngine === "porcupine" && picovoiceKey) {
		wakeDetector = new PorcupineDetector({
			accessKey: picovoiceKey,
			sensitivity: config.wakeWordSensitivity,
		});
		console.log("[voice:init] Wake engine: Porcupine");
	} else if (resolvedWakeEngine === "openwakeword") {
		wakeDetector = new OpenWakeWordSidecar({
			model: config.openWakeWordModel,
			threshold: config.wakeWordSensitivity,
		});
		console.log(
			`[voice:init] Wake engine: openWakeWord (model: ${config.openWakeWordModel})`,
		);
	} else {
		wakeDetector = null;
		console.log("[voice:init] Wake engine: VAD fallback");
	}

	transcriber = new WhisperTranscriber({
		model: config.whisperModel,
		mode: config.sttMode,
	});
	transcriber.setHintProvider({
		getVocabularyHints: () =>
			stateCache?.getVocabularyHints() ?? {
				workspaceNames: [],
				branchNames: [],
				technicalTerms: [],
			},
	});

	// TTS (encrypted store or env var fallback)
	const elevenLabsKey =
		getElevenLabsApiKey() ?? process.env.ELEVENLABS_API_KEY ?? null;
	if (config.ttsProvider === "elevenlabs" && elevenLabsKey) {
		ttsSpeaker = new ElevenLabsSpeaker({ apiKey: elevenLabsKey });
	} else {
		ttsSpeaker = new MacOsFallbackSpeaker();
	}

	// Wire audio pipeline: mic → wake detector + VAD + transcriber + level meter
	let levelFrameCount = 0;
	microphone.onFrame((frame) => {
		// Send RMS level every ~8 frames (~160ms) to renderer for the settings visualizer
		levelFrameCount++;
		if (levelFrameCount % 8 === 0) {
			let sum = 0;
			for (let i = 0; i < frame.length; i++) {
				sum += frame[i] * frame[i];
			}
			const rms = Math.sqrt(sum / frame.length);
			const windows = BrowserWindow.getAllWindows();
			for (const win of windows) {
				win.webContents.send("voice:mic-level", rms);
			}
		}

		// A failed wake detector should not break microphone capture or VAD/STT.
		try {
			wakeDetector?.process(frame);
		} catch (error) {
			console.warn(
				"[voice:init] Wake detector frame processing failed; disabling wake-word detection:",
				error instanceof Error ? error.message : error,
			);
			void wakeDetector?.release();
			wakeDetector = null;
		}
		vad?.process(frame);
		transcriber?.feed(frame);
	});
}

/**
 * Initialize and start the voice control system.
 *
 * Called once after app.whenReady(). Creates all voice subsystem components
 * and wires them into the VoiceDaemon. The daemon manages its own lifecycle
 * from this point — it checks the enabled config flag internally.
 */
export async function initVoice(): Promise<void> {
	const config = getVoiceConfig();

	console.log(
		`[voice:init] Voice control ${config.enabled ? "enabled" : "disabled"} (tts: ${config.ttsProvider}, stt: ${config.sttMode})`,
	);

	// State cache — always initialize for vocabulary hints
	stateCache = new VoiceStateCache({
		getWorkspaces: getWorkspaceList,
		getPaneId: resolvePaneId,
	});
	stateCache.start();

	// Terminal reader
	terminalReader = new TerminalReader();

	// Notification bridge
	notificationBridge = new NotificationBridge(resolveWorkspaceName);

	// Create daemon with all deps wired
	daemon = new VoiceDaemon({
		getConfig: getVoiceConfig,
		getApiKey: getAnthropicApiKey,
		getCachedState: () => stateCache?.getState() ?? null,
		onAlert: (handler) => {
			notificationBridge?.on("alert", handler);
			return () => {
				notificationBridge?.off("alert", handler);
			};
		},
		speak: (text) => ttsSpeaker?.speak(text) ?? Promise.resolve(),
		speakStreaming: (sentence) =>
			ttsSpeaker?.speakStreaming(sentence) ?? Promise.resolve(),
		cancel: () => {
			ttsSpeaker?.cancel();
		},
		onWakeDetected: (handler) => {
			const wakeHandler = () => {
				// Drop pre-wake buffered audio (including wake phrase/silence) so STT
				// only processes the active command utterance.
				transcriber?.reset();
				handler();
			};

			if (wakeDetector) {
				return wakeDetector.onWake(wakeHandler);
			}

			// Open-source fallback when Picovoice is unavailable:
			// use VAD speech-start as the wake trigger.
			if (vad) {
				if (!warnedNoWakeWordFallback) {
					console.warn(
						"[voice:init] No Picovoice key — using VAD speech-start fallback wake mode",
					);
					warnedNoWakeWordFallback = true;
				}
				return vad.onEvent((event) => {
					if (event === "speech-start") {
						wakeHandler();
					}
				});
			}

			// No wake detector and no VAD — use a no-op unsub
			console.warn("[voice:init] Wake detection disabled (no wake backend available)");
			return () => {};
		},
		onSpeechEnd: (handler) => {
			if (vad) {
				return vad.onEvent((event) => {
					if (event === "speech-end") handler();
				});
			}
			return () => {};
		},
		transcribe: async () => {
			if (!transcriber) return "";
			const result = await transcriber.finalize();
			return result.text;
		},
	});

	// Wire voice agent tools into the daemon
	const tools = createVoiceActions({
		getWorkspaces: getWorkspaceList,
		getNotifications: async () => {
			// Notifications are surfaced through the bridge, not queried directly for MVP
			return [];
		},
		readTerminalBuffer: async (paneId, lines) => {
			return terminalReader?.read(paneId, lines) ?? "";
		},
		focusTab: (workspaceId) => {
			const windows = BrowserWindow.getAllWindows();
			if (windows.length > 0) {
				windows[0].webContents.send(
					"deep-link-navigate",
					`/workspace/${workspaceId}`,
				);
				if (windows[0].isMinimized()) windows[0].restore();
				windows[0].focus();
			}
		},
	});
	daemon.setTools(tools);

	// Forward daemon status changes to tRPC subscription
	daemon.onStatusChange((state) => {
		emitVoiceStatus(state);
	});

	// Start notification bridge
	notificationBridge.start();

	// Auto-start runtime if enabled in config
	if (config.enabled) {
		await startVoiceRuntime();
	}
}

/**
 * Start the voice runtime (mic, wake detector, daemon).
 * Idempotent — safe to call multiple times.
 */
export async function startVoiceRuntime(): Promise<void> {
	await queueRuntimeTransition(startVoiceRuntimeInternal);
}

async function startVoiceRuntimeInternal(): Promise<void> {
	if (runtimeStarted) return;
	if (!daemon) {
		console.warn("[voice:init] Cannot start runtime — daemon not initialized. Call initVoice() first.");
		return;
	}
	const config = getVoiceConfig();
	await configureRuntimeComponents(config);

	// Microphone and wake-word are non-fatal — TTS and daemon still work without them
	try {
		await microphone?.start();
		console.log("[voice:init] Microphone started");
	} catch (error) {
		console.warn("[voice:init] Microphone unavailable (voice input disabled):", error instanceof Error ? error.message : error);
	}

	try {
		if (wakeDetector) {
			await wakeDetector.init();
			console.log("[voice:init] Wake-word detector started");
		}
	} catch (error) {
		console.warn("[voice:init] Wake-word detector unavailable:", error instanceof Error ? error.message : error);
		await wakeDetector?.release();
		wakeDetector = null;
	}

	let daemonStarted = false;
	try {
		await daemon.start();
		daemonStarted = daemon.isRunning();
		if (daemonStarted) {
			console.log("[voice:init] Voice daemon started");
		}
	} catch (error) {
		console.error("[voice:init] Failed to start voice daemon:", error);
	}

	if (!daemonStarted) {
		// Ensure audio resources are not left running if daemon failed to start.
		await microphone?.stop();
		await wakeDetector?.release();
		runtimeStarted = false;
		emitVoiceStatus("idle");
		return;
	}

	runtimeStarted = true;
	emitVoiceStatus(daemon.getState());
}

/**
 * Stop the voice runtime (mic, wake detector, daemon).
 * Idempotent — safe to call multiple times.
 */
export async function stopVoiceRuntime(): Promise<void> {
	await queueRuntimeTransition(stopVoiceRuntimeInternal);
}

async function stopVoiceRuntimeInternal(): Promise<void> {
	if (!runtimeStarted) return;

	daemon?.stop();
	await microphone?.stop();
	await wakeDetector?.release();

	runtimeStarted = false;
	emitVoiceStatus("idle");
	console.log("[voice:init] Voice runtime stopped");
}

/**
 * Restart the voice runtime with current config.
 */
export async function restartVoiceRuntime(): Promise<void> {
	await queueRuntimeTransition(async () => {
		await stopVoiceRuntimeInternal();
		await startVoiceRuntimeInternal();
	});
}

function queueRuntimeTransition(operation: () => Promise<void>): Promise<void> {
	const next = runtimeTransitionQueue.then(operation, operation);
	// Keep queue alive even if one transition fails.
	runtimeTransitionQueue = next.catch((error) => {
		console.error("[voice:init] Runtime transition failed:", error);
	});
	return next;
}

/**
 * Stop the voice control system.
 * Called from the before-quit handler.
 */
export async function stopVoice(): Promise<void> {
	console.log("[voice:init] Shutting down voice control...");

	daemon?.stop();
	notificationBridge?.stop();
	stateCache?.stop();
	terminalReader?.dispose();
	await microphone?.stop();
	await wakeDetector?.release();
	runtimeStarted = false;
	emitVoiceStatus("idle");

	daemon = null;
	stateCache = null;
	notificationBridge = null;
	terminalReader = null;
	microphone = null;
	wakeDetector = null;
	vad = null;
	transcriber = null;
	ttsSpeaker = null;
}

/** Get the voice daemon instance for tRPC router use */
export function getVoiceDaemon(): VoiceDaemon | null {
	return daemon;
}
