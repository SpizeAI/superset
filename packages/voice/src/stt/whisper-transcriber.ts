import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_VOCABULARY_HINTS,
	VOICE_CONSTANTS,
} from "../config";
import type {
	SttMode,
	VocabularyHints,
	WhisperModel,
} from "../types";

// ─── Transcriber Interface ───────────────────────────────────────────────────

export interface TranscriberOptions {
	model?: WhisperModel;
	mode?: SttMode;
	/** Path to the Whisper model binary */
	modelPath?: string;
}

export interface TranscriptionResult {
	text: string;
	durationMs: number;
	mode: SttMode;
}

export interface VocabularyHintProvider {
	getVocabularyHints(): VocabularyHints;
}

/**
 * Whisper-based transcriber with dynamic vocabulary priming.
 *
 * Supports two modes:
 * - `batch`: Collects all audio then transcribes (reliable, higher latency)
 * - `streaming`: Feeds frames incrementally (lower latency, requires binding support)
 *
 * Vocabulary priming via Whisper's `initial_prompt` parameter biases recognition
 * toward project-specific terms (workspace names, branch names, technical vocabulary)
 * with near-zero latency cost.
 */
export class WhisperTranscriber {
	private readonly model: WhisperModel;
	private readonly preferredMode: SttMode;
	private readonly modelPath: string | undefined;
	private actualMode: SttMode;
	private streamingSupported: boolean | null = null;
	private audioBuffer: Int16Array[] = [];
	private hintProvider: VocabularyHintProvider | null = null;

	// Metrics
	private modeFailbackCount = 0;

	constructor(options: TranscriberOptions = {}) {
		this.model = options.model ?? "base.en";
		this.preferredMode = options.mode ?? "batch";
		this.modelPath = options.modelPath;
		this.actualMode = this.preferredMode;
	}

	setHintProvider(provider: VocabularyHintProvider): void {
		this.hintProvider = provider;
	}

	/**
	 * Feed an audio frame for incremental processing.
	 * In batch mode, frames are buffered. In streaming mode, they're processed live.
	 */
	feed(frame: Int16Array): void {
		this.audioBuffer.push(frame);
	}

	/**
	 * Finalize transcription after VAD signals end-of-utterance.
	 * In batch mode, processes the full buffer. In streaming mode, finalizes partial.
	 */
	async finalize(): Promise<TranscriptionResult> {
		const startMs = Date.now();

		// Build vocabulary priming prompt
		const primingPrompt = this.buildPrimingPrompt();

		// Merge buffered frames into single PCM array
		const audio = mergeFrames(this.audioBuffer);
		this.audioBuffer = [];

		// Attempt streaming if preferred, fall back to batch on failure
		if (this.actualMode === "streaming" && this.streamingSupported !== false) {
			try {
				const text = await this.transcribeStreaming(audio, primingPrompt);
				return {
					text,
					durationMs: Date.now() - startMs,
					mode: "streaming",
				};
			} catch (error) {
				console.warn(
					"[voice:stt] Streaming transcription failed, falling back to batch:",
					error,
				);
				this.streamingSupported = false;
				this.actualMode = "batch";
				this.modeFailbackCount++;
			}
		}

		const text = await this.transcribeBatch(audio, primingPrompt);
		return {
			text,
			durationMs: Date.now() - startMs,
			mode: "batch",
		};
	}

	/**
	 * Build a bounded vocabulary priming prompt from the hint provider.
	 * Truncates to MAX_PRIMING_PROMPT_CHARS to avoid degrading Whisper quality.
	 */
	buildPrimingPrompt(): string {
		const hints = this.hintProvider?.getVocabularyHints()
			?? DEFAULT_VOCABULARY_HINTS;

		const parts: string[] = ["Superset voice control."];

		const workspaceNames = dedupeAndClean(hints.workspaceNames);
		if (workspaceNames.length > 0) {
			parts.push(`Workspaces: ${workspaceNames.join(", ")}.`);
		}

		const branchNames = dedupeAndClean(hints.branchNames);
		if (branchNames.length > 0) {
			parts.push(`Branches: ${branchNames.join(", ")}.`);
		}

		const terms = dedupeAndClean(hints.technicalTerms);
		if (terms.length > 0) {
			parts.push(`Common terms: ${terms.join(", ")}.`);
		}

		let prompt = parts.join(" ");

		// Truncate to max chars, cutting at last space before limit
		if (prompt.length > VOICE_CONSTANTS.MAX_PRIMING_PROMPT_CHARS) {
			prompt = truncateAtWord(
				prompt,
				VOICE_CONSTANTS.MAX_PRIMING_PROMPT_CHARS,
			);
		}

		return prompt;
	}

	reset(): void {
		this.audioBuffer = [];
	}

	getMetrics(): { modeFailbackCount: number; primingPromptChars: number } {
		return {
			modeFailbackCount: this.modeFailbackCount,
			primingPromptChars: this.buildPrimingPrompt().length,
		};
	}

	getActualMode(): SttMode {
		return this.actualMode;
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	private async transcribeBatch(
		audio: Int16Array,
		initialPrompt: string,
	): Promise<string> {
		if (audio.length === 0) return "";

		// Write PCM to a temp WAV file for whisper.cpp
		const wavPath = join(tmpdir(), `whisper-${randomUUID()}.wav`);
		try {
			writeWav16k(wavPath, audio);
			return await runWhisperCpp(wavPath, {
				model: this.model,
				modelPath: this.modelPath,
				prompt: initialPrompt,
				language: "en",
			});
		} finally {
			try {
				unlinkSync(wavPath);
			} catch {
				// Best-effort cleanup
			}
		}
	}

	private async transcribeStreaming(
		_audio: Int16Array,
		_initialPrompt: string,
	): Promise<string> {
		// whisper.cpp CLI doesn't support streaming — always fall back to batch
		throw new Error("Streaming not supported by whisper.cpp CLI");
	}
}

// ─── whisper.cpp direct adapter ─────────────────────────────────────────────
// Calls whisper.cpp main binary directly to get --prompt support.
// whisper-node's shell wrapper doesn't expose the prompt flag.

let _whisperPaths: { binPath: string; modelsDir: string } | null = null;

function resolveWhisperPaths(): { binPath: string; modelsDir: string } {
	if (_whisperPaths) return _whisperPaths;

	// whisper-node stores whisper.cpp under its lib directory.
	// Walk up from this file to find node_modules/whisper-node.
	const thisDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		// Monorepo hoisted (packages/voice/src/stt/ → root node_modules)
		join(thisDir, "..", "..", "..", "..", "node_modules", "whisper-node"),
		// Package-local
		join(thisDir, "..", "..", "node_modules", "whisper-node"),
	];

	for (const dir of candidates) {
		const binPath = join(dir, "lib", "whisper.cpp", "main");
		const modelsDir = join(dir, "lib", "whisper.cpp", "models");
		if (existsSync(binPath)) {
			_whisperPaths = { binPath, modelsDir };
			return _whisperPaths;
		}
	}

	throw new Error(
		"[voice:stt] whisper.cpp binary not found. Run: bun add whisper-node && npx whisper-node download",
	);
}

const MODEL_FILES: Record<string, string> = {
	"tiny": "ggml-tiny.bin",
	"tiny.en": "ggml-tiny.en.bin",
	"base": "ggml-base.bin",
	"base.en": "ggml-base.en.bin",
	"small": "ggml-small.bin",
	"small.en": "ggml-small.en.bin",
	"medium": "ggml-medium.bin",
	"medium.en": "ggml-medium.en.bin",
};

async function runWhisperCpp(
	wavPath: string,
	options: {
		model: string;
		modelPath?: string;
		prompt: string;
		language: string;
	},
): Promise<string> {
	const { execFile: execFileCb } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execFile = promisify(execFileCb);

	const { binPath, modelsDir } = resolveWhisperPaths();
	const modelFile =
		options.modelPath ??
		join(modelsDir, MODEL_FILES[options.model] ?? `ggml-${options.model}.bin`);

	const args = [
		"-m", modelFile,
		"-f", wavPath,
		"-l", options.language,
		"--no-timestamps",
	];

	if (options.prompt) {
		args.push("--prompt", options.prompt);
	}

	try {
		const { stdout } = await execFile(binPath, args, {
			cwd: join(binPath, ".."),
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		});

		// whisper.cpp outputs transcript lines to stdout, strip whitespace
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("["))
			.join(" ")
			.trim();
	} catch (error) {
		throw new Error(
			`[voice:stt] whisper.cpp failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Write 16kHz mono Int16 PCM data as a WAV file.
 * whisper-node/whisper.cpp requires 16kHz WAV input.
 */
function writeWav16k(filePath: string, pcm: Int16Array): void {
	const sampleRate = 16_000;
	const numChannels = 1;
	const bitsPerSample = 16;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);
	const dataSize = pcm.length * (bitsPerSample / 8);
	const headerSize = 44;

	const buffer = Buffer.alloc(headerSize + dataSize);

	// RIFF header
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8);

	// fmt subchunk
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16); // subchunk size
	buffer.writeUInt16LE(1, 20); // PCM format
	buffer.writeUInt16LE(numChannels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(byteRate, 28);
	buffer.writeUInt16LE(blockAlign, 32);
	buffer.writeUInt16LE(bitsPerSample, 34);

	// data subchunk
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataSize, 40);

	// Write PCM samples
	for (let i = 0; i < pcm.length; i++) {
		buffer.writeInt16LE(pcm[i] ?? 0, headerSize + i * 2);
	}

	writeFileSync(filePath, buffer);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mergeFrames(frames: Int16Array[]): Int16Array {
	if (frames.length === 0) return new Int16Array(0);
	if (frames.length === 1) return frames[0]!;

	const totalLength = frames.reduce((sum, f) => sum + f.length, 0);
	const merged = new Int16Array(totalLength);

	let offset = 0;
	for (const frame of frames) {
		merged.set(frame, offset);
		offset += frame.length;
	}

	return merged;
}

function dedupeAndClean(items: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const item of items) {
		const cleaned = item.trim();
		if (cleaned && !seen.has(cleaned.toLowerCase())) {
			seen.add(cleaned.toLowerCase());
			result.push(cleaned);
		}
	}

	return result;
}

function truncateAtWord(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;

	const truncated = text.slice(0, maxChars);
	const lastSpace = truncated.lastIndexOf(" ");

	if (lastSpace > 0) {
		return truncated.slice(0, lastSpace);
	}

	return truncated;
}
