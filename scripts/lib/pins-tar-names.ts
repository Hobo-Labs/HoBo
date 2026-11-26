/**
 * How the archive reader reads an entry's name besides its spelling: the
 * code points another file system ignores, the forms under which two names
 * are one file elsewhere, and how a name is shown in a refusal. A name
 * reaches these as the reader holds it: its bytes, one latin1 character
 * each.
 *
 * Erasable TypeScript with node builtins only.
 */

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A name's bytes read as UTF-8, any that are not UTF-8 as U+FFFD. */
const asText = (name: string): string =>
	Buffer.from(name, "latin1").toString("utf8");

/**
 * Unicode 15.1's Default_Ignorable_Code_Point, as DerivedCoreProperties.txt
 * lists it, in inclusive ranges. HFS+ and some Linux casefold kernels drop
 * such code points when they compare names, so `mi‍rror` is `mirror`
 * there. `pins-archive-fold.test.ts` checks this list against the table
 * written from that file.
 */
export const DEFAULT_IGNORABLE: readonly (readonly [number, number])[] = [
	[0x00ad, 0x00ad],
	[0x034f, 0x034f],
	[0x061c, 0x061c],
	[0x115f, 0x1160],
	[0x17b4, 0x17b5],
	[0x180b, 0x180f],
	[0x200b, 0x200f],
	[0x202a, 0x202e],
	[0x2060, 0x206f],
	[0x3164, 0x3164],
	[0xfe00, 0xfe0f],
	[0xfeff, 0xfeff],
	[0xffa0, 0xffa0],
	[0xfff0, 0xfff8],
	[0x1bca0, 0x1bca3],
	[0x1d173, 0x1d17a],
	[0xe0000, 0xe0fff],
];

/** The first default-ignorable code point in `name`, if it holds one. */
export function firstIgnorable(name: string): number | undefined {
	for (const char of asText(name)) {
		const point = char.codePointAt(0) ?? 0;
		if (
			DEFAULT_IGNORABLE.some(([low, high]) => point >= low && point <= high)
		) {
			return point;
		}
	}
	return undefined;
}

/**
 * A name as a case-insensitive, normalisation-insensitive file system sees it,
 * Unicode's canonical caseless key NFD(casefold(NFD(name))): its bytes read
 * as UTF-8, put in NFD, case-folded by `toLowerCase().toUpperCase()
 * .toLowerCase()`, and put in NFD again. NFD comes first so that marks are
 * ordered before they are folded (NFC would compose U+0345 into a letter and
 * fold it to an iota after the other marks). `pins-archive-fold.test.ts`
 * checks that this joins each code point of Unicode 15.1 with its full case
 * folding, the folding ext4 and f2fs casefold directories apply, and checks
 * whole names on a random sample. It also joins some names those keep apart
 * (`ı` with `i`), and bytes that are not UTF-8 all read as U+FFFD: both only
 * refuse more. It does not model NTFS, which does not normalise: that is
 * `upcaseName`, the reader's second key.
 */
export function foldName(name: string): string {
	const text = asText(name).normalize("NFD");
	return text.toLowerCase().toUpperCase().toLowerCase().normalize("NFD");
}

/**
 * The BMP code points whose simple uppercase (UnicodeData.txt) is one code
 * point while their full uppercase, what `toUpperCase` gives, is several:
 * the Greek letters with a subscript iota.
 */
const SIMPLE_UPPER_ONLY: ReadonlyMap<number, number> = new Map([
	[0x1f80, 0x1f88],
	[0x1f81, 0x1f89],
	[0x1f82, 0x1f8a],
	[0x1f83, 0x1f8b],
	[0x1f84, 0x1f8c],
	[0x1f85, 0x1f8d],
	[0x1f86, 0x1f8e],
	[0x1f87, 0x1f8f],
	[0x1f90, 0x1f98],
	[0x1f91, 0x1f99],
	[0x1f92, 0x1f9a],
	[0x1f93, 0x1f9b],
	[0x1f94, 0x1f9c],
	[0x1f95, 0x1f9d],
	[0x1f96, 0x1f9e],
	[0x1f97, 0x1f9f],
	[0x1fa0, 0x1fa8],
	[0x1fa1, 0x1fa9],
	[0x1fa2, 0x1faa],
	[0x1fa3, 0x1fab],
	[0x1fa4, 0x1fac],
	[0x1fa5, 0x1fad],
	[0x1fa6, 0x1fae],
	[0x1fa7, 0x1faf],
	[0x1fb3, 0x1fbc],
	[0x1fc3, 0x1fcc],
	[0x1ff3, 0x1ffc],
]);

/**
 * A name as NTFS compares it: each UTF-16 unit of its text, un-normalised,
 * replaced by its simple uppercase, as the volume's $UpCase table does.
 * Code points past the BMP are left as they are. Two names NTFS stores as
 * one file have one `upcaseName`; `pins-archive-fold.test.ts` checks the
 * mapping for every BMP code point of Unicode 15.1, and holds random names
 * to it.
 */
export function upcaseName(name: string): string {
	let upcased = "";
	for (const char of asText(name)) {
		const point = char.codePointAt(0) ?? 0;
		const upper = char.toUpperCase();
		const simple =
			point > 0xffff
				? undefined
				: (SIMPLE_UPPER_ONLY.get(point) ??
					(upper.length === 1 ? upper.charCodeAt(0) : undefined));
		upcased += simple === undefined ? char : String.fromCharCode(simple);
	}
	return upcased;
}

/** A character for a message: printable ASCII as it is (`"` and `\\` escaped), anything else as `\\u{XXXX}`. */
function shownChar(char: string): string {
	if (char === '"' || char === "\\") return `\\${char}`;
	const point = char.codePointAt(0) ?? 0;
	if (point >= 0x20 && point <= 0x7e) return char;
	return `\\u{${point.toString(16).toUpperCase().padStart(4, "0")}}`;
}

/**
 * A name for a message, quoted and unambiguous: its bytes read as UTF-8, each
 * printable ASCII character as it is and every other code point as
 * `\\u{XXXX}`, so a letter that does not show (U+3164, U+115F), a variation
 * selector or a direction override can never hide in a refusal. Bytes that
 * are not UTF-8 are shown as `\\xNN`.
 */
export function shownName(raw: string): string {
	let text: string | undefined;
	try {
		text = UTF8.decode(Buffer.from(raw, "latin1"));
	} catch {
		text = undefined;
	}
	let shown = "";
	for (const char of text ?? raw) {
		const code = char.charCodeAt(0);
		shown +=
			text === undefined && code >= 0x80
				? `\\x${code.toString(16).padStart(2, "0")}`
				: shownChar(char);
	}
	return `"${shown}"`;
}
