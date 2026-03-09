import { VOICE_CONSTANTS } from "../config";

export interface PendingIntent {
	token: string;
	action: string;
	args: Record<string, unknown>;
	createdAt: number;
	expiresAt: number;
}

/**
 * Manages conversational window state and destructive action confirmation.
 *
 * The conversation window opens after a voice response and allows follow-up
 * utterances without the wake word. It tracks:
 * - Window open/close state with timeout
 * - Exchange count for auto-close
 * - Pending destructive intents that require confirmation tokens
 *
 * Destructive action flow:
 * 1. Agent identifies destructive action -> creates pending intent with token
 * 2. Speaks confirmation prompt to user
 * 3. User confirms -> token is validated and consumed
 * 4. Stale tokens (>10s) are rejected to prevent accidental execution
 */
export class ConversationWindow {
	private open = false;
	private exchanges = 0;
	private maxExchanges: number;
	private timeoutMs: number;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pendingIntent: PendingIntent | null = null;
	private closeHandlers: Array<() => void> = [];

	private static readonly INTENT_TTL_MS = 10_000;
	private static tokenCounter = 0;

	constructor(options: { maxExchanges?: number; timeoutMs?: number } = {}) {
		this.maxExchanges = options.maxExchanges ??
			VOICE_CONSTANTS.MAX_CONVERSATION_EXCHANGES;
		this.timeoutMs = options.timeoutMs ?? 8_000;
	}

	onClose(handler: () => void): () => void {
		this.closeHandlers.push(handler);
		return () => {
			this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
		};
	}

	openWindow(): void {
		this.open = true;
		this.resetTimer();
	}

	/**
	 * Record a conversational exchange. Extends the timeout.
	 * Returns false if the window should auto-close (max exchanges reached).
	 */
	recordExchange(): boolean {
		this.exchanges++;
		if (this.exchanges >= this.maxExchanges) {
			this.close();
			return false;
		}
		this.resetTimer();
		return true;
	}

	close(): void {
		this.open = false;
		this.exchanges = 0;
		this.pendingIntent = null;
		this.clearTimer();
		for (const handler of this.closeHandlers) {
			handler();
		}
	}

	isOpen(): boolean {
		return this.open;
	}

	getExchangeCount(): number {
		return this.exchanges;
	}

	// ─── Destructive Intent Confirmation ─────────────────────────────────────

	/**
	 * Create a pending intent token for a destructive action.
	 * The token must be presented back via confirmIntent() within TTL.
	 */
	createPendingIntent(
		action: string,
		args: Record<string, unknown>,
	): PendingIntent {
		const now = Date.now();
		const token = `intent_${++ConversationWindow.tokenCounter}_${now}`;

		this.pendingIntent = {
			token,
			action,
			args,
			createdAt: now,
			expiresAt: now + ConversationWindow.INTENT_TTL_MS,
		};

		return this.pendingIntent;
	}

	/**
	 * Attempt to confirm a pending destructive intent.
	 * Returns the intent if valid, null if expired/missing/mismatched.
	 */
	confirmIntent(token: string): PendingIntent | null {
		if (!this.pendingIntent) return null;
		if (this.pendingIntent.token !== token) return null;

		const now = Date.now();
		if (now > this.pendingIntent.expiresAt) {
			this.pendingIntent = null;
			return null;
		}

		const confirmed = this.pendingIntent;
		this.pendingIntent = null;
		return confirmed;
	}

	/**
	 * Check if there's a live pending intent (not expired).
	 */
	hasPendingIntent(): boolean {
		if (!this.pendingIntent) return false;
		if (Date.now() > this.pendingIntent.expiresAt) {
			this.pendingIntent = null;
			return false;
		}
		return true;
	}

	getPendingIntent(): PendingIntent | null {
		if (this.hasPendingIntent()) return this.pendingIntent;
		return null;
	}

	clearPendingIntent(): void {
		this.pendingIntent = null;
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	private resetTimer(): void {
		this.clearTimer();
		this.timer = setTimeout(() => {
			this.close();
		}, this.timeoutMs);
	}

	private clearTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
