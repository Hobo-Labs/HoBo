const UTF8 = new TextDecoder("utf-8", { fatal: true });

const asText = (name: string): string =>
	Buffer.from(name, "latin1").toString("utf8");

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

export function foldName(name: string): string {
	const text = asText(name).normalize("NFD");
	return text.toLowerCase().toUpperCase().toLowerCase().normalize("NFD");
}

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

function shownChar(char: string): string {
	if (char === '"' || char === "\\") return `\\${char}`;
	const point = char.codePointAt(0) ?? 0;
	if (point >= 0x20 && point <= 0x7e) return char;
	return `\\u{${point.toString(16).toUpperCase().padStart(4, "0")}}`;
}

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
