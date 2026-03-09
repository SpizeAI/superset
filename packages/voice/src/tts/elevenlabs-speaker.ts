export interface ElevenLabsSpeakerOptions {
	apiKey: string;
	voiceId?: string;
	modelId?: string;
}

export interface SpeakOptions {
	/** If true, resolves as soon as audio starts playing rather than when it finishes */
	resolveOnStart?: boolean;
}

/**
 * ElevenLabs streaming TTS engine.
 *
 * Streams text sentence-by-sentence into ElevenLabs and plays audio chunks
 * as they arrive, minimizing time-to-first-audio. Supports pre-generation
 * for speculative cache entries.
 */
export class ElevenLabsSpeaker {
	private readonly apiKey: string;
	private readonly voiceId: string;
	private readonly modelId: string;
	private currentAbort: AbortController | null = null;
	private responseCache = new Map<string, Buffer>();
	private readonly maxCacheEntries = 50;

	constructor(options: ElevenLabsSpeakerOptions) {
		this.apiKey = options.apiKey;
		this.voiceId = options.voiceId ?? "21m00Tcm4TlvDq8ikWAM"; // Rachel default
		this.modelId = options.modelId ?? "eleven_turbo_v2_5";
	}

	/**
	 * Speak text with streaming playback. Resolves when playback completes
	 * (or when audio starts if resolveOnStart is true).
	 */
	async speak(text: string, options: SpeakOptions = {}): Promise<void> {
		this.cancel();

		// Check short-response cache
		const cached = this.responseCache.get(text);
		if (cached) {
			await this.playAudioBuffer(cached);
			return;
		}

		const abort = new AbortController();
		this.currentAbort = abort;

		try {
			const response = await fetch(
				`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream`,
				{
					method: "POST",
					headers: {
						"xi-api-key": this.apiKey,
						"Content-Type": "application/json",
						Accept: "audio/mpeg",
					},
					body: JSON.stringify({
						text,
						model_id: this.modelId,
						voice_settings: {
							stability: 0.5,
							similarity_boost: 0.75,
						},
					}),
					signal: abort.signal,
				},
			);

			if (!response.ok) {
				throw new Error(
					`[voice:tts:elevenlabs] API error ${response.status}: ${response.statusText}`,
				);
			}

			const audioBuffer = await this.collectStream(response, abort.signal);

			// Cache short responses for reuse
			if (text.length < 100) {
				this.cacheResponse(text, audioBuffer);
			}

			await this.playAudioBuffer(audioBuffer);
		} catch (error) {
			if (abort.signal.aborted) return; // Cancelled intentionally
			throw error;
		} finally {
			if (this.currentAbort === abort) {
				this.currentAbort = null;
			}
		}
	}

	/**
	 * Stream text sentence-by-sentence for overlapped Claude-to-TTS playback.
	 * Each sentence starts playing as soon as its audio is ready.
	 */
	async speakStreaming(sentence: string): Promise<void> {
		await this.speak(sentence);
	}

	/**
	 * Pre-generate audio for speculative cache without playing it.
	 * Returns the raw audio buffer for storage.
	 */
	async preGenerate(text: string): Promise<Buffer> {
		const cached = this.responseCache.get(text);
		if (cached) return cached;

		const response = await fetch(
			`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`,
			{
				method: "POST",
				headers: {
					"xi-api-key": this.apiKey,
					"Content-Type": "application/json",
					Accept: "audio/mpeg",
				},
				body: JSON.stringify({
					text,
					model_id: this.modelId,
					voice_settings: {
						stability: 0.5,
						similarity_boost: 0.75,
					},
				}),
			},
		);

		if (!response.ok) {
			throw new Error(
				`[voice:tts:elevenlabs] Pre-generation failed ${response.status}`,
			);
		}

		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		this.cacheResponse(text, buffer);
		return buffer;
	}

	cancel(): void {
		if (this.currentAbort) {
			this.currentAbort.abort();
			this.currentAbort = null;
		}
	}

	isAvailable(): boolean {
		return !!this.apiKey;
	}

	private async collectStream(
		response: Response,
		signal: AbortSignal,
	): Promise<Buffer> {
		const reader = response.body?.getReader();
		if (!reader) throw new Error("[voice:tts:elevenlabs] No response body");

		const chunks: Uint8Array[] = [];
		while (true) {
			if (signal.aborted) throw new Error("Aborted");
			const { done, value } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}

		return Buffer.concat(chunks);
	}

	private async playAudioBuffer(_buffer: Buffer): Promise<void> {
		// Playback implementation depends on the audio output mechanism.
		// In Electron main process, this will use a native audio player.
		// Stub for now — will be wired to platform audio in desktop integration.
		console.log("[voice:tts:elevenlabs] Audio playback (stub)");
	}

	private cacheResponse(text: string, buffer: Buffer): void {
		if (this.responseCache.size >= this.maxCacheEntries) {
			const firstKey = this.responseCache.keys().next().value;
			if (firstKey !== undefined) {
				this.responseCache.delete(firstKey);
			}
		}
		this.responseCache.set(text, buffer);
	}
}
