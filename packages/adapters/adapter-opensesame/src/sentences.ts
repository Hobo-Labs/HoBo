/**
 * The sentences OpenSesame writes after its `opensesame: ` prefix, found in a
 * stream of stderr that its child shares. Everything here is a read of text
 * the child may have written: it returns text to classify and decides nothing.
 */

// public-contract: the prefix OpenSesame writes before its own sentences on stderr (apps/cli); outcome.ts reads by it and the tests pin it.
export const OWN_PREFIX = "opensesame: ";
/** How much of what follows the prefix is read; the longest sentence OpenSesame writes is under 300. */
export const SENTENCE_LIMIT = 512;

/**
 * Where each sentence's window starts and ends: after an `opensesame: `, up to
 * the next prefix or SENTENCE_LIMIT characters, whichever comes first. Stopping
 * at the next prefix keeps the windows apart (they sum to at most the text), so
 * each character is read once however the prefix is repeated; none of
 * OpenSesame's sentences holds the prefix itself.
 */
export function sentenceWindows(
	stderr: string,
): readonly (readonly [number, number])[] {
	const out: (readonly [number, number])[] = [];
	let at = stderr.indexOf(OWN_PREFIX);
	while (at >= 0) {
		const from = at + OWN_PREFIX.length;
		const next = stderr.indexOf(OWN_PREFIX, from);
		const end = Math.min(
			from + SENTENCE_LIMIT,
			next < 0 ? stderr.length : next,
		);
		out.push([from, end]);
		at = next;
	}
	return out;
}

/** What follows each `opensesame: ` in the text, up to the end of its line, the next prefix, or the limit. */
export function sentencesOf(stderr: string): string[] {
	return sentenceWindows(stderr).map(
		([from, end]) => stderr.slice(from, end).split(/[\r\n]/u, 1)[0] ?? "",
	);
}

/** What a scan holds: the sentences it kept, at most one per pattern it was asked for. */
export type SentenceScan = {
	push(chunk: string): void;
	sentences(): readonly string[];
	/** Characters carried to the next chunk for a sentence in progress; never more than `CARRY_LIMIT`. */
	held(): number;
};

/** The most a scan carries between chunks: a full window and the start of a prefix on either side of it. */
export const CARRY_LIMIT = SENTENCE_LIMIT + 2 * OWN_PREFIX.length;

/** Index of the first line break of `text` from `from` up to `cap`, or -1. */
function lineBreak(text: string, from: number, cap: number): number {
	const at = text.slice(from, cap).search(/[\r\n]/u);
	return at < 0 ? -1 : from + at;
}

/**
 * Hands `take` each sentence of `text` that can be told complete, and returns
 * what must be carried to the next chunk: from the unfinished sentence's prefix,
 * or the end of the text that might be the start of a prefix. A sentence ends at
 * a line break, the next prefix, SENTENCE_LIMIT characters, or (`last`) the end
 * of the stream: as `sentenceWindows` and `sentencesOf` cut it, whatever the
 * chunks were. One pass: every step moves on, so the work is linear in the text.
 */
function readSentences(
	text: string,
	last: boolean,
	take: (sentence: string) => void,
): string {
	let pos = 0;
	for (;;) {
		const at = text.indexOf(OWN_PREFIX, pos);
		if (at < 0) {
			if (last) return "";
			return text.slice(Math.max(pos, text.length - (OWN_PREFIX.length - 1)));
		}
		const from = at + OWN_PREFIX.length;
		const limit = from + SENTENCE_LIMIT;
		const next = text.indexOf(OWN_PREFIX, from);
		const cap = Math.min(limit, next < 0 ? text.length : next);
		const line = lineBreak(text, from, cap);
		// A prefix that starts before the limit is whole in the text once the text reaches this far.
		const known =
			last ||
			line >= 0 ||
			next >= 0 ||
			text.length >= limit + OWN_PREFIX.length - 1;
		if (!known) return text.slice(at);
		pos = line >= 0 ? line : cap;
		take(text.slice(from, pos));
	}
}

/**
 * A reader of stderr that sees every chunk as it arrives and keeps, of
 * OpenSesame's sentences, only those that match one of `patterns` (the first
 * match of each pattern). It is independent of what a capture retains: a child that
 * writes more after the line, or before it, cannot evict it, because nothing is
 * evicted: what it holds is at most `patterns.length` sentences of at most
 * SENTENCE_LIMIT characters, and a carry of the one sentence in progress.
 */
export function createSentenceScan(patterns: readonly RegExp[]): SentenceScan {
	const kept: (string | undefined)[] = patterns.map(() => undefined);
	// A sentence fills every slot whose pattern it matches: one that is in two shapes counts as both, as it does when the whole text is read.
	const take = (sentence: string) => {
		patterns.forEach((pattern, at) => {
			if (pattern.test(sentence)) kept[at] ??= sentence;
		});
	};
	let carry = "";
	return {
		push(chunk) {
			carry = readSentences(carry + chunk, false, take);
		},
		sentences() {
			readSentences(carry, true, take);
			return kept.filter((sentence) => sentence !== undefined);
		},
		held: () => carry.length,
	};
}
