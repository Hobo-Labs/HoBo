export type MergeSegment =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{
			kind: "conflict";
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

function lines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

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
	const rest = line.slice(size).replace(/\r?\n$/, "");
	if (rest === "" || (marker !== "=" && rest.startsWith(" "))) return marker;
	return undefined;
}

export function parseMergeSegments(
	merged: string,
	size: number,
): readonly MergeSegment[] {
	const segments: MergeSegment[] = [];
	let settled = "";
	let side: Side | undefined;
	let region = { ours: "", base: "", theirs: "" };
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

export type RegionContext = Readonly<{ before: string; after: string }>;

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

export type RegionRefusal =
	| "conflict-marker"
	| "oversized-resolution"
	| "repeated-context";

function contentLines(text: string): string[] {
	return lines(text)
		.map((line) => line.replace(/\r?\n$/, ""))
		.filter((line) => line.trim() !== "");
}

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

export function fitRegionResolution(
	region: Extract<MergeSegment, { kind: "conflict" }>,
	resolution: string,
	context: RegionContext = { before: "", after: "" },
): { text: string } | { refusal: RegionRefusal } {
	const sides = region.ours + region.theirs;
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
