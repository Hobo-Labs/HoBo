/**
 * A three-way merge result as alternating settled text and conflict regions.
 * The agent only ever supplies text for a region; settled text is copied
 * through untouched, so a resolution cannot change a line git already merged.
 */
export type MergeSegment =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{
			kind: "conflict";
			/** Position among the file's conflict regions, from zero. */
			id: number;
			ours: string;
			base: string;
			theirs: string;
	  }>;

export class ConflictParseError extends Error {
	constructor() {
		super("unparseable conflict markers");
	}
}

const MARKERS = ["<", "|", "=", ">"] as const;
type Marker = (typeof MARKERS)[number];
type Side = "ours" | "base" | "theirs";

/** Lines with their terminators kept, so joining them reproduces the input. */
function lines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * A marker length no input line can be mistaken for: one more than the
 * longest run of a marker character that starts a line in any side, and at
 * least git's default of seven.
 */
export function markerSizeFor(sides: readonly string[]): number {
	let longest = 6;
	for (const side of sides)
		for (const line of lines(side)) {
			const first = line.charAt(0);
			if (!MARKERS.some((marker) => marker === first)) continue;
			let run = 1;
			while (line.charAt(run) === first) run++;
			longest = Math.max(longest, run);
		}
	return longest + 1;
}

function markerOf(line: string, size: number): Marker | undefined {
	const first = line.charAt(0);
	const marker = MARKERS.find((candidate) => candidate === first);
	if (!marker || !line.startsWith(marker.repeat(size))) return undefined;
	// A longer run is file content; a label follows a space.
	const rest = line.slice(size).replace(/\r?\n$/, "");
	if (rest === "" || (marker !== "=" && rest.startsWith(" "))) return marker;
	return undefined;
}

/**
 * Split `git merge-file --diff3` output (markers of `size` characters) into
 * segments. Markers out of order, or a region left open, are refused.
 */
export function parseMergeSegments(
	merged: string,
	size: number,
): readonly MergeSegment[] {
	const segments: MergeSegment[] = [];
	let settled = "";
	let side: Side | undefined;
	let region = { ours: "", base: "", theirs: "" };
	// The side a marker must close, and the side it opens.
	const closes = {
		"<": undefined,
		"|": "ours",
		"=": "base",
		">": "theirs",
	} as const satisfies Record<Marker, Side | undefined>;
	const opens = {
		"<": "ours",
		"|": "base",
		"=": "theirs",
		">": undefined,
	} as const satisfies Record<Marker, Side | undefined>;
	for (const line of lines(merged)) {
		const marker = markerOf(line, size);
		if (!marker) {
			if (side) region[side] += line;
			else settled += line;
			continue;
		}
		if (side !== closes[marker]) throw new ConflictParseError();
		if (marker === "<") {
			if (settled) segments.push({ kind: "text", text: settled });
			settled = "";
			region = { ours: "", base: "", theirs: "" };
		}
		if (marker === ">")
			segments.push({
				kind: "conflict",
				id: segments.filter((segment) => segment.kind === "conflict").length,
				...region,
			});
		side = opens[marker];
	}
	if (side) throw new ConflictParseError();
	if (settled) segments.push({ kind: "text", text: settled });
	return Object.freeze(segments);
}

/** The settled lines on each side of a region. */
export type RegionContext = Readonly<{ before: string; after: string }>;

/** The text an engine sees around a region: the nearest settled lines. */
export function regionContext(
	segments: readonly MergeSegment[],
	index: number,
	contextLines: number,
): RegionContext {
	const settled = (at: number) => {
		const segment = segments[at];
		return segment?.kind === "text" ? lines(segment.text) : [];
	};
	const before = settled(index - 1);
	return {
		before: contextLines
			? before.slice(Math.max(0, before.length - contextLines)).join("")
			: "",
		after: settled(index + 1)
			.slice(0, contextLines)
			.join(""),
	};
}

/** Why an engine's text for one region was refused. Fixed codes, never text. */
export type RegionRefusal =
	| "conflict-marker"
	| "oversized-resolution"
	| "repeated-context";

/** The lines of a text that have anything but whitespace, without terminators. */
function contentLines(text: string): string[] {
	return lines(text)
		.map((line) => line.replace(/\r?\n$/, ""))
		.filter((line) => line.trim() !== "");
}

/**
 * Whether a resolution repeats the settled line next to its region. git's
 * zdiff3 moves lines both sides share out of a region, and a model told about
 * them as context sometimes writes them again; the file then has the line
 * twice. A line either side itself starts or ends with is not a repeat.
 */
function repeatsContext(
	region: Extract<MergeSegment, { kind: "conflict" }>,
	resolution: string,
	context: RegionContext,
): boolean {
	const said = contentLines(resolution);
	const sides = [contentLines(region.ours), contentLines(region.theirs)];
	const before = contentLines(context.before).at(-1);
	const after = contentLines(context.after)[0];
	return (
		(before !== undefined &&
			said[0] === before &&
			sides.every((side) => side[0] !== before)) ||
		(after !== undefined &&
			said.at(-1) === after &&
			sides.every((side) => side.at(-1) !== after))
	);
}

/**
 * Check one region's replacement and fit it to the file: the region's line
 * ending style, and a final newline when both sides ended with one.
 */
export function fitRegionResolution(
	region: Extract<MergeSegment, { kind: "conflict" }>,
	resolution: string,
	/** The settled text around the region, to catch a repeat of it. */
	context: RegionContext = { before: "", after: "" },
): { text: string } | { refusal: RegionRefusal } {
	const sides = region.ours + region.theirs;
	// Room to combine both sides and add glue; not room for unrelated code.
	if (resolution.length > 2 * sides.length + 4096)
		return { refusal: "oversized-resolution" };
	if (/^(?:<{7,}|>{7,}|\|{7,})(?: |\r?$)/m.test(resolution))
		return { refusal: "conflict-marker" };
	if (repeatsContext(region, resolution, context))
		return { refusal: "repeated-context" };
	let fitted = resolution.replace(/\r\n/g, "\n");
	const terminated = [region.ours, region.theirs].every(
		(text) => text === "" || text.endsWith("\n"),
	);
	if (terminated && fitted !== "" && !fitted.endsWith("\n")) fitted += "\n";
	if (sides.includes("\r\n")) fitted = fitted.replace(/\n/g, "\r\n");
	return { text: fitted };
}

/** Rebuild the file: settled text as it was, each region replaced by its text. */
export function composeMerged(
	segments: readonly MergeSegment[],
	resolutions: ReadonlyMap<number, string>,
): string {
	return segments
		.map((segment) => {
			if (segment.kind === "text") return segment.text;
			const text = resolutions.get(segment.id);
			if (text === undefined) throw new Error("unresolved conflict region");
			return text;
		})
		.join("");
}

/**
 * The text each region had in a file built from these segments, found by
 * matching the settled text around it. Undefined when the file no longer
 * has that shape, or when two regions touch and cannot be told apart.
 */
export function regionTexts(
	segments: readonly MergeSegment[],
	file: string,
): ReadonlyMap<number, string> | undefined {
	const texts = new Map<number, string>();
	let position = 0;
	for (const [index, segment] of segments.entries()) {
		if (segment.kind === "text") {
			if (!file.startsWith(segment.text, position)) return undefined;
			position += segment.text.length;
			continue;
		}
		const next = segments[index + 1];
		if (next?.kind === "conflict") return undefined;
		const end = next ? file.indexOf(next.text, position) : file.length;
		if (end < 0) return undefined;
		texts.set(segment.id, file.slice(position, end));
		position = end;
	}
	return position === file.length ? texts : undefined;
}
