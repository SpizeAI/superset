import { createHash } from "node:crypto";
import { VOICE_CONSTANTS } from "../config";
import type { FollowUpClass, SpeculativeAudioEntry, SpeculativeKey } from "../types";

export interface SpeculativeCacheOptions {
	ttlMs?: number;
	maxEntries?: number;
	maxBackgroundGenerations?: number;
}

/**
 * Speculative TTS pre-generation cache.
 *
 * After a spoken prompt with high-probability branching (e.g. "Want the summary?"),
 * this cache pre-generates likely follow-up responses in the background:
 * - "affirmative" → detailed response body
 * - "negative" → short acknowledgement
 * - "clarify" → disambiguation question
 *
 * Entries are keyed by (conversationId, contextHash, followUpClass) and expire
 * after a short TTL. Context mutations (new workspace, new alert) invalidate
 * all entries for the current conversation.
 *
 * Safety: destructive flows are never pre-generated.
 */
export class SpeculativeCache {
	private entries = new Map<string, SpeculativeAudioEntry>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly maxBackgroundGenerations: number;
	private activeGenerations = 0;

	// Metrics
	private hitCount = 0;
	private missCount = 0;
	private wasteCount = 0;

	constructor(options: SpeculativeCacheOptions = {}) {
		this.ttlMs = options.ttlMs ?? VOICE_CONSTANTS.SPECULATIVE_TTL_MS;
		this.maxEntries = options.maxEntries ?? 20;
		this.maxBackgroundGenerations = options.maxBackgroundGenerations ?? 3;
	}

	/**
	 * Look up a speculative entry. Returns the entry if found and not expired.
	 */
	get(key: SpeculativeKey): SpeculativeAudioEntry | null {
		const cacheKey = this.serializeKey(key);
		const entry = this.entries.get(cacheKey);

		if (!entry) {
			this.missCount++;
			return null;
		}

		if (Date.now() > entry.expiresAt) {
			this.entries.delete(cacheKey);
			this.wasteCount++;
			this.missCount++;
			return null;
		}

		this.hitCount++;
		return entry;
	}

	/**
	 * Store a speculative entry with TTL.
	 */
	put(key: SpeculativeKey, text: string, audioPath: string): void {
		this.evictExpired();

		if (this.entries.size >= this.maxEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) {
				this.wasteCount++;
				this.entries.delete(oldestKey);
			}
		}

		const now = Date.now();
		const cacheKey = this.serializeKey(key);
		this.entries.set(cacheKey, {
			key,
			text,
			audioPath,
			createdAt: now,
			expiresAt: now + this.ttlMs,
		});
	}

	/**
	 * Trigger speculative generation for a set of follow-up classes.
	 * The generator callback should produce audio and return the file path.
	 * Rate-limited to maxBackgroundGenerations concurrent requests.
	 */
	async triggerSpeculative(
		conversationId: string,
		context: string[],
		branches: Array<{ followUpClass: FollowUpClass; text: string }>,
		generator: (text: string) => Promise<string>,
	): Promise<void> {
		const contextHash = this.hashContext(context);

		const tasks = branches.map(async (branch) => {
			if (this.activeGenerations >= this.maxBackgroundGenerations) return;

			const key: SpeculativeKey = {
				conversationId,
				contextHash,
				followUpClass: branch.followUpClass,
			};

			// Don't re-generate if already cached (direct lookup to avoid polluting metrics)
			const cacheKey = this.serializeKey(key);
			const existing = this.entries.get(cacheKey);
			if (existing && Date.now() <= existing.expiresAt) return;

			this.activeGenerations++;
			try {
				const audioPath = await generator(branch.text);
				this.put(key, branch.text, audioPath);
			} catch (error) {
				console.warn(
					"[voice:speculative] Generation failed for",
					branch.followUpClass,
					error,
				);
			} finally {
				this.activeGenerations--;
			}
		});

		await Promise.allSettled(tasks);
	}

	/**
	 * Invalidate all entries for a conversation. Call on context mutation
	 * (new active workspace, new alert event, explicit dismissal).
	 */
	invalidateConversation(conversationId: string): void {
		for (const [cacheKey, entry] of this.entries) {
			if (entry.key.conversationId === conversationId) {
				this.wasteCount++;
				this.entries.delete(cacheKey);
			}
		}
	}

	/**
	 * Invalidate all entries. Call on major state changes.
	 */
	clear(): void {
		this.wasteCount += this.entries.size;
		this.entries.clear();
	}

	getMetrics(): {
		hitCount: number;
		missCount: number;
		wasteCount: number;
		activeEntries: number;
		hitRate: number;
	} {
		const total = this.hitCount + this.missCount;
		return {
			hitCount: this.hitCount,
			missCount: this.missCount,
			wasteCount: this.wasteCount,
			activeEntries: this.entries.size,
			hitRate: total > 0 ? this.hitCount / total : 0,
		};
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	private serializeKey(key: SpeculativeKey): string {
		return `${key.conversationId}:${key.contextHash}:${key.followUpClass}`;
	}

	private hashContext(context: string[]): string {
		const hash = createHash("sha256");
		hash.update(context.join("\n"));
		return hash.digest("hex").slice(0, 16);
	}

	private evictExpired(): void {
		const now = Date.now();
		for (const [cacheKey, entry] of this.entries) {
			if (now > entry.expiresAt) {
				this.wasteCount++;
				this.entries.delete(cacheKey);
			}
		}
	}
}
