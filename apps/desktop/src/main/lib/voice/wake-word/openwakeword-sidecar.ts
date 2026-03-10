import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { app } from "electron";

export type WakeHandler = () => void;

export interface OpenWakeWordOptions {
	model?: string;
	threshold?: number;
	triggerLevel?: number;
	refractorySeconds?: number;
	chunkSize?: number;
}

interface SidecarEvent {
	event: "ready" | "wake" | "error" | "health";
	score?: number;
	model?: string;
	message?: string;
}

/**
 * Node adapter for the openWakeWord Python sidecar.
 *
 * Mirrors the PorcupineDetector interface (init/process/onWake/release)
 * so it can be used as a drop-in wake engine replacement.
 *
 * The sidecar is a Python child process that reads raw PCM frames from stdin
 * and emits JSON wake events on stdout. This adapter manages the process
 * lifecycle with crash recovery and bounded backoff.
 */
export class OpenWakeWordSidecar {
	private child: ChildProcess | null = null;
	private readline: Interface | null = null;
	private wakeHandlers: WakeHandler[] = [];
	private options: OpenWakeWordOptions;
	private ready = false;
	private restartCount = 0;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private released = false;

	private static readonly MAX_RESTARTS = 5;
	private static readonly BASE_BACKOFF_MS = 500;
	private static readonly MAX_BACKOFF_MS = 16_000;
	private static readonly HANDSHAKE_TIMEOUT_MS = 15_000;

	constructor(options: OpenWakeWordOptions = {}) {
		this.options = options;
	}

	onWake(handler: WakeHandler): () => void {
		this.wakeHandlers.push(handler);
		return () => {
			this.wakeHandlers = this.wakeHandlers.filter((h) => h !== handler);
		};
	}

	async init(): Promise<void> {
		if (this.released) {
			throw new Error("[voice:oww] Sidecar already released");
		}
		await this.startProcess();
	}

	/**
	 * Feed a 16kHz mono Int16Array frame to the sidecar via stdin.
	 * Returns false (wake detection is async via onWake handlers).
	 */
	process(frame: Int16Array): boolean {
		if (!this.child?.stdin?.writable || !this.ready) {
			return false;
		}

		// Write raw PCM int16 LE bytes to sidecar stdin
		const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
		try {
			this.child.stdin.write(buffer);
		} catch {
			// stdin closed — sidecar likely crashed, restart will handle it
		}
		return false;
	}

	async release(): Promise<void> {
		this.released = true;
		this.ready = false;

		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}

		this.killProcess();
	}

	get isReady(): boolean {
		return this.ready;
	}

	get frameLength(): number {
		return this.options.chunkSize ?? 1280;
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	private async startProcess(): Promise<void> {
		this.killProcess();

		const pythonPath = this.resolvePythonPath();
		const serverPath = this.resolveServerPath();

		if (!existsSync(serverPath)) {
			throw new Error(
				`[voice:oww] server.py not found at ${serverPath}. Run: bash sidecars/openwakeword/setup.sh`,
			);
		}

		const args = [serverPath];
		if (this.options.model) args.push("--model", this.options.model);
		if (this.options.threshold != null) args.push("--threshold", String(this.options.threshold));
		if (this.options.triggerLevel != null) args.push("--trigger-level", String(this.options.triggerLevel));
		if (this.options.refractorySeconds != null) args.push("--refractory-seconds", String(this.options.refractorySeconds));
		if (this.options.chunkSize != null) args.push("--chunk-size", String(this.options.chunkSize));

		console.log(`[voice:oww] Starting sidecar: ${pythonPath} ${args.join(" ")}`);

		this.child = spawn(pythonPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		// Prevent sidecar restarts from surfacing EPIPE as uncaught exceptions.
		this.child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code !== "EPIPE") {
				console.warn(`[voice:oww] stdin error: ${err.message}`);
			}
		});

		// Forward stderr for debugging
		this.child.stderr?.on("data", (data: Buffer) => {
			const line = data.toString().trim();
			if (line) console.log(`[voice:oww:stderr] ${line}`);
		});

		// Parse JSON events from stdout
		this.readline = createInterface({ input: this.child.stdout! });
		this.readline.on("line", (line) => {
			this.handleEvent(line);
		});

		// Handle process exit
		this.child.on("exit", (code, signal) => {
			this.ready = false;
			console.warn(`[voice:oww] Sidecar exited (code=${code}, signal=${signal})`);
			if (!this.released) {
				this.scheduleRestart();
			}
		});

		this.child.on("error", (err) => {
			console.error("[voice:oww] Sidecar spawn error:", err.message);
			if (!this.released) {
				this.scheduleRestart();
			}
		});

		// Wait for ready handshake
		await this.waitForReady();
	}

	private handleEvent(line: string): void {
		let event: SidecarEvent;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		switch (event.event) {
			case "ready":
				this.ready = true;
				this.restartCount = 0;
				console.log("[voice:oww] Sidecar ready");
				break;

			case "wake":
				console.log(`[voice:oww] Wake detected (score=${event.score}, model=${event.model})`);
				for (const handler of this.wakeHandlers) {
					handler();
				}
				break;

			case "error":
				console.error(`[voice:oww] Sidecar error: ${event.message}`);
				break;
		}
	}

	private waitForReady(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error("[voice:oww] Sidecar handshake timed out"));
			}, OpenWakeWordSidecar.HANDSHAKE_TIMEOUT_MS);

			const check = () => {
				if (this.ready) {
					clearTimeout(timeout);
					resolve();
				} else if (this.released) {
					clearTimeout(timeout);
					reject(new Error("[voice:oww] Released during init"));
				} else {
					setTimeout(check, 100);
				}
			};
			check();
		});
	}

	private scheduleRestart(): void {
		if (this.restartCount >= OpenWakeWordSidecar.MAX_RESTARTS) {
			console.error("[voice:oww] Max restarts exceeded — giving up");
			return;
		}

		const backoff = Math.min(
			OpenWakeWordSidecar.BASE_BACKOFF_MS * 2 ** this.restartCount,
			OpenWakeWordSidecar.MAX_BACKOFF_MS,
		);
		this.restartCount++;

		console.log(`[voice:oww] Restarting in ${backoff}ms (attempt ${this.restartCount})`);
		this.restartTimer = setTimeout(async () => {
			try {
				await this.startProcess();
			} catch (error) {
				console.error("[voice:oww] Restart failed:", error instanceof Error ? error.message : error);
			}
		}, backoff);
	}

	private killProcess(): void {
		if (this.readline) {
			this.readline.close();
			this.readline = null;
		}
		if (this.child) {
			try {
				this.child.stdin?.end();
				this.child.kill("SIGTERM");
			} catch {
				// already dead
			}
			this.child = null;
		}
		this.ready = false;
	}

	private resolvePythonPath(): string {
		// Prefer the sidecar venv python, fallback to system python3
		const sidecarDir = this.resolveSidecarDir();
		const venvPython = join(sidecarDir, ".venv", "bin", "python");
		if (existsSync(venvPython)) return venvPython;
		return "python3";
	}

	private resolveServerPath(): string {
		return join(this.resolveSidecarDir(), "server.py");
	}

	private resolveSidecarDir(): string {
		// In dev, resolve from the project source
		const devPath = resolve(app.getAppPath(), "sidecars/openwakeword");
		if (existsSync(devPath)) return devPath;

		// In packaged builds, resolve from resources
		const resourcePath = resolve(process.resourcesPath ?? "", "sidecars/openwakeword");
		if (existsSync(resourcePath)) return resourcePath;

		return devPath; // let it fail with a clear error
	}
}
