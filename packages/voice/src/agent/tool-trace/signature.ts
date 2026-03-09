import { createHash } from "node:crypto";
import { normalizeUtterance } from "./utterance-normalizer";

/**
 * Generate a stable signature from an utterance for trace index lookup.
 *
 * The signature is a short hash of the normalized token sequence.
 * Equivalent phrasings produce the same signature because normalization
 * strips fillers and maps synonyms before hashing.
 *
 * Examples:
 * - "show me my workspaces" → same sig as "list workspaces please"
 * - "what's the status of auth workspace" → same sig as "check status auth workspace"
 */
export function generateSignature(text: string): string {
	const { normalized } = normalizeUtterance(text);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Check if two utterances would produce the same trace signature.
 */
export function signaturesMatch(a: string, b: string): boolean {
	return generateSignature(a) === generateSignature(b);
}
