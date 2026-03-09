import { VOICE_CONSTANTS } from "@superset/voice";
import { getDaemonTerminalManager } from "../terminal";

/**
 * Ring buffer for terminal output per pane.
 *
 * Captures streamed terminal data into fixed-size buffers, providing
 * instant reads for the voice system without hitting the daemon.
 * ANSI escape sequences are stripped to keep voice context clean.
 */
class RingBuffer {
	private lines: string[] = [];
	private readonly maxLines: number;

	constructor(maxLines: number) {
		this.maxLines = maxLines;
	}

	push(data: string): void {
		// Strip ANSI escape sequences for clean voice context
		const clean = this.stripAnsi(data);
		const newLines = clean.split("\n");

		for (const line of newLines) {
			// Skip empty lines from splitting
			if (line.length === 0 && newLines.length > 1) continue;
			this.lines.push(line);
		}

		// Trim to max size
		if (this.lines.length > this.maxLines) {
			this.lines = this.lines.slice(-this.maxLines);
		}
	}

	read(count: number): string {
		const start = Math.max(0, this.lines.length - count);
		return this.lines.slice(start).join("\n");
	}

	clear(): void {
		this.lines = [];
	}

	private stripAnsi(text: string): string {
		// Remove ANSI escape sequences (CSI, OSC, etc.)
		return text.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes requires matching control chars
			/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
			"",
		);
	}
}

/**
 * Terminal reader that maintains ring buffers for active panes.
 *
 * Subscribes to terminal data events from the DaemonTerminalManager and
 * captures output into per-pane ring buffers. The voice agent reads from
 * these buffers instead of querying the terminal host directly.
 */
export class TerminalReader {
	private buffers = new Map<string, RingBuffer>();
	private listeners: Array<() => void> = [];
	private paneListeners = new Map<string, () => void>();
	private readonly maxLines: number;

	constructor(maxLines?: number) {
		this.maxLines = maxLines ?? VOICE_CONSTANTS.TERMINAL_RING_BUFFER_LINES;
	}

	/**
	 * Start capturing terminal data for a set of pane IDs.
	 */
	startCapture(paneIds: string[]): void {
		const terminal = getDaemonTerminalManager();

		for (const paneId of paneIds) {
			if (this.buffers.has(paneId)) continue;

			const buffer = new RingBuffer(this.maxLines);
			this.buffers.set(paneId, buffer);

			const handler = (data: string) => {
				buffer.push(data);
			};

			terminal.on(`data:${paneId}`, handler);
			const cleanup = () => {
				terminal.off(`data:${paneId}`, handler);
			};
			this.listeners.push(cleanup);
			this.paneListeners.set(paneId, cleanup);
		}
	}

	/**
	 * Stop capturing for a pane.
	 */
	stopCapture(paneId: string): void {
		const cleanup = this.paneListeners.get(paneId);
		if (cleanup) {
			cleanup();
			this.paneListeners.delete(paneId);
			this.listeners = this.listeners.filter((l) => l !== cleanup);
		}
		this.buffers.delete(paneId);
	}

	/**
	 * Read recent terminal output for a pane.
	 * Falls back to empty string if no buffer exists.
	 */
	read(paneId: string, lines?: number): string {
		const buffer = this.buffers.get(paneId);
		if (!buffer) return "";
		return buffer.read(lines ?? this.maxLines);
	}

	/**
	 * Stop all captures and clean up listeners.
	 */
	dispose(): void {
		for (const cleanup of this.listeners) {
			cleanup();
		}
		this.listeners = [];
		this.buffers.clear();
		this.paneListeners.clear();
	}
}
