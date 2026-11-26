/**
 * `pattern` with each ASCII letter written as a class of its two cases, for a
 * pattern that is case-insensitive without the `i` flag. With the `u` flag,
 * which `\p{…}` needs, `i` folds by Unicode: `[A-Za-z]` and `\w` then also
 * match `ſ` (U+017F) and `K` (U+212A), so a look-behind that says "not after a
 * letter" refuses a start after one, and a credential written after `ſ` is not
 * found. A letter that `iu` folds a non-ASCII one into keeps it (`s` takes
 * `ſ`, `k` takes `K`), so a name matches what it did under `iu`. Only for
 * literal text and group syntax: not escapes or classes.
 */
export function anyCase(pattern: string): string {
	return pattern.replace(/[A-Za-z]/g, (letter) => {
		const lower = letter.toLowerCase();
		// What `i` with `u` also folds to these two: `ſ` to `s`, `K` to `k`.
		const folded = lower === "s" ? "\\u017F" : lower === "k" ? "\\u212A" : "";
		return `[${letter.toUpperCase()}${lower}${folded}]`;
	});
}

/** The secret names the shared secret-key shape and its differential read. */
export const SECRET_KEY_NAMES = anyCase(
	"token|secret|auth(?:orization)?|session|password|passwd|pwd|requirepass|api[_-]?key|secret[_-]?key|access[_-]?key|private[_-]?key|session[_-]?id",
);
