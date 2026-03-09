import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VoiceSecrets } from "@superset/voice";
import { SUPERSET_HOME_DIR } from "../app-environment";
import {
	encrypt,
	decrypt,
} from "lib/trpc/routers/auth/utils/crypto-storage";

const SECRETS_FILE = join(SUPERSET_HOME_DIR, "voice-secrets.enc");

/**
 * Encrypted storage for voice provider API keys.
 *
 * Reuses the same AES-256-GCM crypto pattern as auth token storage,
 * keeping secrets encrypted at rest and tied to the machine ID.
 * Non-sensitive config (enabled, model, timeouts) lives in the
 * settings table instead.
 */

export function loadVoiceSecrets(): VoiceSecrets {
	try {
		if (!existsSync(SECRETS_FILE)) return {};
		const data = readFileSync(SECRETS_FILE);
		const json = decrypt(data);
		return JSON.parse(json) as VoiceSecrets;
	} catch (error) {
		console.warn("[voice:secrets] Failed to load secrets:", error);
		return {};
	}
}

export function saveVoiceSecrets(secrets: VoiceSecrets): void {
	const data = encrypt(JSON.stringify(secrets));
	writeFileSync(SECRETS_FILE, data, { mode: 0o600 });
}

export function getElevenLabsApiKey(): string | null {
	return loadVoiceSecrets().elevenLabsApiKey ?? null;
}

export function getPicovoiceAccessKey(): string | null {
	return loadVoiceSecrets().picovoiceAccessKey ?? null;
}
