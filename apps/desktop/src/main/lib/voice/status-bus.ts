import { EventEmitter } from "node:events";

/**
 * Shared voice status bus.
 *
 * Decouples the voice daemon (init.ts) from the tRPC router — both import
 * this module instead of importing each other, breaking the circular dependency.
 *
 * The daemon calls `emitVoiceStatus()` when pipeline state changes.
 * The router subscribes via `voiceStatusBus.on("status", ...)`.
 */
export const voiceStatusBus = new EventEmitter();

let currentVoiceState = "idle";

export function emitVoiceStatus(state: string): void {
	currentVoiceState = state;
	voiceStatusBus.emit("status", state);
}

export function getCurrentVoiceState(): string {
	return currentVoiceState;
}
