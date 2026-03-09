import type { NormalizedUtterance } from "./types";

/**
 * Filler words and particles stripped during normalization.
 * These don't contribute to intent classification.
 */
const FILLER_WORDS = new Set([
	"a", "an", "the", "please", "can", "you", "could", "would",
	"just", "go", "ahead", "and", "then", "now", "also", "hey",
	"hi", "ok", "okay", "um", "uh", "like", "so", "well",
	"superset", "do", "for", "me", "my", "to", "in", "on",
	"of", "it", "is", "that", "this", "with",
]);

/**
 * Synonym map for common voice command variations.
 * Maps spoken alternatives to canonical forms.
 */
const SYNONYMS: Record<string, string> = {
	show: "list",
	display: "list",
	what: "list",
	workspaces: "workspace",
	terminals: "terminal",
	notifications: "notification",
	agents: "agent",
	tell: "status",
	check: "status",
	how: "status",
	read: "terminal",
	output: "terminal",
	kill: "stop",
	cancel: "stop",
	abort: "stop",
	close: "stop",
	switch: "focus",
	open: "focus",
	navigate: "focus",
	bring: "focus",
	type: "send",
	write: "send",
	input: "send",
	create: "new",
	start: "new",
	make: "new",
};

/**
 * Normalizes a voice utterance for signature matching.
 *
 * Strips filler words, applies synonym mapping, lowercases, and
 * sorts tokens to produce order-independent signatures. This means
 * "show me my workspaces" and "list workspaces please" both produce
 * the same normalized form.
 */
export function normalizeUtterance(text: string): NormalizedUtterance {
	const lower = text.toLowerCase().trim();

	// Tokenize: split on whitespace and punctuation
	const rawTokens = lower
		.replace(/[^\w\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 0);

	// Strip fillers and apply synonyms
	const tokens = rawTokens
		.filter((t) => !FILLER_WORDS.has(t))
		.map((t) => SYNONYMS[t] ?? t);

	// Deduplicate and sort for order-independent matching
	const unique = [...new Set(tokens)].sort();

	return {
		original: text,
		normalized: unique.join(" "),
		tokens: unique,
	};
}
