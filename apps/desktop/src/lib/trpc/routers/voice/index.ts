import { observable } from "@trpc/server/observable";
import { EventEmitter } from "node:events";
import { settings } from "@superset/local-db";
import { DEFAULT_VOICE_CONFIG } from "@superset/voice";
import type { VoiceConfig } from "@superset/voice";
import { localDb } from "main/lib/local-db";
import {
	loadVoiceSecrets,
	saveVoiceSecrets,
} from "main/lib/voice/voice-secrets";
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

const voiceEvents = new EventEmitter();

// Used by the voice daemon to push status changes
export function emitVoiceStatus(state: string): void {
	voiceEvents.emit("status", state);
}

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
				const handler = (state: string) => {
					emit.next({ state });
				};

				voiceEvents.on("status", handler);

				return () => {
					voiceEvents.off("status", handler);
				};
			});
		}),

		toggle: publicProcedure.mutation(() => {
			const current = getVoiceSettings();
			const newEnabled = !current.enabled;

			localDb
				.insert(settings)
				.values({ id: 1, voiceEnabled: newEnabled })
				.onConflictDoUpdate({
					target: settings.id,
					set: { voiceEnabled: newEnabled },
				})
				.run();

			voiceEvents.emit("status", newEnabled ? "listening-for-wake" : "idle");
			return { enabled: newEnabled };
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
					conversationTimeoutMs: z.number().positive().optional(),
					commandTimeoutMs: z.number().positive().optional(),
					voiceTraceEnabled: z.boolean().optional(),
				}),
			)
			.mutation(({ input }) => {
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

		hasSecrets: publicProcedure.query(() => {
			const secrets = loadVoiceSecrets();
			return {
				hasElevenLabsKey: !!secrets.elevenLabsApiKey,
				hasPicovoiceKey: !!secrets.picovoiceAccessKey,
			};
		}),
	});
};
