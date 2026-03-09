import { execFile } from "node:child_process";

/**
 * macOS `say` command TTS fallback.
 *
 * Guaranteed-available fallback when ElevenLabs is unavailable or fails.
 * Uses the system `say` command which requires no API keys or network.
 * Lower quality but zero-latency startup and infinite reliability.
 */
export class MacOsFallbackSpeaker {
	private currentProcess: ReturnType<typeof execFile> | null = null;
	private readonly voice: string;
	private readonly rate: number;

	constructor(options: { voice?: string; rate?: number } = {}) {
		this.voice = options.voice ?? "Samantha";
		this.rate = options.rate ?? 200;
	}

	async speak(text: string): Promise<void> {
		this.cancel();

		return new Promise((resolve, reject) => {
			const sanitized = sanitizeForShell(text);

			this.currentProcess = execFile(
				"say",
				["-v", this.voice, "-r", String(this.rate), sanitized],
				(error) => {
					this.currentProcess = null;
					if (error) {
						// Error code 9 = killed by cancel(), not a real error
						if ((error as NodeJS.ErrnoException).signal === "SIGTERM") {
							resolve();
							return;
						}
						reject(
							new Error(`[voice:tts:macos] say failed: ${error.message}`),
						);
						return;
					}
					resolve();
				},
			);
		});
	}

	async speakStreaming(sentence: string): Promise<void> {
		await this.speak(sentence);
	}

	cancel(): void {
		if (this.currentProcess) {
			this.currentProcess.kill("SIGTERM");
			this.currentProcess = null;
		}
	}

	isAvailable(): boolean {
		return process.platform === "darwin";
	}
}

/**
 * Strip characters that could cause issues with the `say` command.
 * Keeps alphanumeric, spaces, basic punctuation.
 */
function sanitizeForShell(text: string): string {
	return text.replace(/[^\w\s.,!?;:'"()\-/]/g, "");
}
