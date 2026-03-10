import { observable } from "@trpc/server/observable";
import { settings } from "@superset/local-db";
import { DEFAULT_VOICE_CONFIG } from "@superset/voice";
import type { VoiceConfig } from "@superset/voice";
import { localDb } from "main/lib/local-db";
import {
	loadVoiceSecrets,
	saveVoiceSecrets,
} from "main/lib/voice/voice-secrets";
import {
	voiceStatusBus,
	getCurrentVoiceState,
} from "main/lib/voice/status-bus";
import {
	startVoiceRuntime,
	stopVoiceRuntime,
	restartVoiceRuntime,
	getVoiceDaemon,
} from "main/lib/voice/init";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * Voice control tRPC router.
 *
 * Provides the renderer with:
 * - `voice.status` subscription for live pipeline state updates
 * - `voice.toggle` mutation to enable/disable voice
 * - `voice.getConfig` / `voice.updateConfig` for settings
 * - `voice.setSecrets` for encrypted API key storage
 */

function getVoiceSettings(): Partial<VoiceConfig> {
	const row = localDb.select().from(settings).get();
	if (!row) return {};

	return {
		enabled: row.voiceEnabled ?? DEFAULT_VOICE_CONFIG.enabled,
		proactiveAlerts:
			row.voiceProactiveAlerts ?? DEFAULT_VOICE_CONFIG.proactiveAlerts,
		ttsProvider: (row.voiceTtsProvider as VoiceConfig["ttsProvider"]) ??
			DEFAULT_VOICE_CONFIG.ttsProvider,
		sttMode: (row.voiceSttMode as VoiceConfig["sttMode"]) ??
			DEFAULT_VOICE_CONFIG.sttMode,
		whisperModel: (row.voiceWhisperModel as VoiceConfig["whisperModel"]) ??
			DEFAULT_VOICE_CONFIG.whisperModel,
		wakeWordSensitivity:
			row.voiceWakeWordSensitivity ?? DEFAULT_VOICE_CONFIG.wakeWordSensitivity,
		micDeviceIndex:
			row.voiceMicDeviceIndex ?? DEFAULT_VOICE_CONFIG.micDeviceIndex,
		conversationTimeoutMs:
			row.voiceConversationTimeoutMs ?? DEFAULT_VOICE_CONFIG.conversationTimeoutMs,
		commandTimeoutMs:
			row.voiceCommandTimeoutMs ?? DEFAULT_VOICE_CONFIG.commandTimeoutMs,
		voiceTraceEnabled:
			row.voiceTraceEnabled ?? DEFAULT_VOICE_CONFIG.voiceTraceEnabled,
	};
}

export const createVoiceRouter = () => {
	return router({
		status: publicProcedure.subscription(() => {
			return observable<{ state: string }>((emit) => {
				// Immediately send current state so renderer doesn't start stale
				emit.next({ state: getCurrentVoiceState() });

				const handler = (state: string) => {
					emit.next({ state });
				};

				voiceStatusBus.on("status", handler);

				return () => {
					voiceStatusBus.off("status", handler);
				};
			});
		}),

		toggle: publicProcedure.mutation(async () => {
			const current = getVoiceSettings();
			const newEnabled = !current.enabled;

			// Persist the setting
			localDb
				.insert(settings)
				.values({ id: 1, voiceEnabled: newEnabled })
				.onConflictDoUpdate({
					target: settings.id,
					set: { voiceEnabled: newEnabled },
				})
				.run();

			// Start or stop the actual voice runtime
			if (newEnabled) {
				await startVoiceRuntime();
			} else {
				await stopVoiceRuntime();
			}

			return { enabled: newEnabled, state: getCurrentVoiceState() };
		}),

		sendCommand: publicProcedure
			.input(z.object({ text: z.string().min(1) }))
			.mutation(async ({ input }) => {
				let daemon = getVoiceDaemon();
				if (!daemon) {
					return {
						response: "Voice daemon not initialized.",
						executionPath: "fallback",
					};
				}

				// Ensure runtime is started when voice is enabled.
				if (!daemon.isRunning()) {
					const current = getVoiceSettings();
					const enabled = current.enabled ?? DEFAULT_VOICE_CONFIG.enabled;
					if (!enabled) {
						return {
							response:
								"Voice control is disabled. Enable it in Settings > Voice Control.",
							executionPath: "fallback",
						};
					}

					await startVoiceRuntime();
					daemon = getVoiceDaemon();
					if (!daemon || !daemon.isRunning()) {
						return {
							response:
								"Voice runtime failed to start. Check native voice dependencies and logs.",
							executionPath: "fallback",
						};
					}
				}

				return daemon.sendCommand(input.text);
			}),

		getConfig: publicProcedure.query((): VoiceConfig => {
			const saved = getVoiceSettings();
			return { ...DEFAULT_VOICE_CONFIG, ...saved };
		}),

		updateConfig: publicProcedure
			.input(
				z.object({
					enabled: z.boolean().optional(),
					proactiveAlerts: z.boolean().optional(),
					ttsProvider: z.enum(["elevenlabs", "macos"]).optional(),
					sttMode: z.enum(["batch", "streaming"]).optional(),
					whisperModel: z.enum(["base.en", "small.en"]).optional(),
					wakeWordSensitivity: z.number().min(0).max(1).optional(),
					micDeviceIndex: z.number().int().min(-1).optional(),
					conversationTimeoutMs: z.number().positive().optional(),
					commandTimeoutMs: z.number().positive().optional(),
					voiceTraceEnabled: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const previous = {
					...DEFAULT_VOICE_CONFIG,
					...getVoiceSettings(),
				};
				const updateSet: Record<string, unknown> = {};

				if (input.enabled !== undefined)
					updateSet.voiceEnabled = input.enabled;
				if (input.proactiveAlerts !== undefined)
					updateSet.voiceProactiveAlerts = input.proactiveAlerts;
				if (input.ttsProvider !== undefined)
					updateSet.voiceTtsProvider = input.ttsProvider;
				if (input.sttMode !== undefined)
					updateSet.voiceSttMode = input.sttMode;
				if (input.whisperModel !== undefined)
					updateSet.voiceWhisperModel = input.whisperModel;
				if (input.wakeWordSensitivity !== undefined)
					updateSet.voiceWakeWordSensitivity = input.wakeWordSensitivity;
				if (input.micDeviceIndex !== undefined)
					updateSet.voiceMicDeviceIndex = input.micDeviceIndex;
				if (input.conversationTimeoutMs !== undefined)
					updateSet.voiceConversationTimeoutMs = input.conversationTimeoutMs;
				if (input.commandTimeoutMs !== undefined)
					updateSet.voiceCommandTimeoutMs = input.commandTimeoutMs;
				if (input.voiceTraceEnabled !== undefined)
					updateSet.voiceTraceEnabled = input.voiceTraceEnabled;

				if (Object.keys(updateSet).length > 0) {
					localDb
						.insert(settings)
						.values({ id: 1, ...updateSet })
						.onConflictDoUpdate({
							target: settings.id,
							set: updateSet,
						})
						.run();
				}

				const next = {
					...previous,
					...input,
				};

				const enabledChanged =
					input.enabled !== undefined && input.enabled !== previous.enabled;

				if (enabledChanged) {
					if (next.enabled) {
						await startVoiceRuntime();
					} else {
						await stopVoiceRuntime();
					}
					return { success: true };
				}

				const restartSensitiveChange =
					input.ttsProvider !== undefined ||
					input.sttMode !== undefined ||
					input.whisperModel !== undefined ||
					input.wakeWordSensitivity !== undefined ||
					input.micDeviceIndex !== undefined;

				if (restartSensitiveChange && next.enabled) {
					await restartVoiceRuntime();
				}

				return { success: true };
			}),

		setSecrets: publicProcedure
			.input(
				z.object({
					elevenLabsApiKey: z.string().optional(),
					picovoiceAccessKey: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const existing = loadVoiceSecrets();
				saveVoiceSecrets({
					...existing,
					...input,
				});
				return { success: true };
			}),

		listAudioDevices: publicProcedure.query(async () => {
			try {
				const { PvRecorder } = await import(
					"@picovoice/pvrecorder-node"
				);
				const devices: string[] = PvRecorder.getAvailableDevices();
				return devices.map((name: string, index: number) => ({
					index,
					name,
				}));
			} catch {
				return [];
			}
		}),

		hasSecrets: publicProcedure.query(() => {
			const secrets = loadVoiceSecrets();
			return {
				hasElevenLabsKey: !!secrets.elevenLabsApiKey,
				hasPicovoiceKey: !!secrets.picovoiceAccessKey,
			};
		}),
	});
};
