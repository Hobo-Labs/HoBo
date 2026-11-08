import { must } from "@hobo/core/total-access";
/**
 * Rubberhose chrome primitives for the terminal (site/DESIGN.md).
 *
 * The design contract is a 1930s rubberhose cartoon — Steamboat Willie ink,
 * Cuphead title cards, Fleischer bounce — and it says explicitly: **never
 * flat SaaS chrome**. Translated to a fixed-cell grid:
 *
 * | pillar (DESIGN.md)      | terminal translation                          |
 * |-------------------------|-----------------------------------------------|
 * | thick ink outlines      | heavy box-drawing (┏━┓), never hairline rules  |
 * | hard sticker shadows    | offset solid-block shadow, +1 col / +1 row     |
 * | title-card type         | the Chewy `HOBO_LOGO_TUI` sprite as a card     |
 * | strict B&W base         | no colour by default                           |
 * | spark / go are rare     | vermillion only for refusal, green for done    |
 * | reduced motion honored  | callers pass a static frame                    |
 *
 * Everything here is pure and fixed-width: a card of a given width always
 * returns the same line count and every line is exactly `width` cells, so
 * the differential renderer never sees spurious geometry churn.
 */

/** DESIGN.md tokens that survive the trip to a terminal. */
export const INK = {
	topLeft: "┏",
	topRight: "┓",
	bottomLeft: "┗",
	bottomRight: "┛",
	horizontal: "━",
	vertical: "┃",
	/** Hard sticker offset — a solid block, not a soft gradient. */
	shadow: "▒",
} as const;

/** Rare accents. Vermillion = refusal/blocked, green = done. Nothing else. */
export const ACCENT = {
	spark: "\u001b[38;5;160m",
	go: "\u001b[38;5;28m",
	dim: "\u001b[2m",
	bold: "\u001b[1m",
	reset: "\u001b[0m",
} as const;

export type AccentName = "spark" | "go" | "none";

export interface CardOptions {
	/** Exact outer width in cells (including the shadow column). */
	readonly width: number;
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	/** Optional title rendered into the top rule as a title card would. */
	readonly title?: string;
	/** Rare status accent; omitted or "none" keeps the card strictly B&W. */
	readonly accent?: AccentName;
	/** Drop the sticker shadow (used where a card sits flush to an edge). */
	readonly flat?: boolean;
}

/** Visible width, ignoring SGR escapes (colour must not shift geometry). */
export function cellWidth(text: string): number {
	return text.replace(
		new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
		"",
	).length;
}

/** Pad/truncate to exactly `width` visible cells, preserving any escapes. */
export function fitCells(text: string, width: number): string {
	const w = Math.max(0, Math.trunc(width));
	const visible = cellWidth(text);
	if (visible === w) return text;
	if (visible < w) return text + " ".repeat(w - visible);
	if (w === 0) return "";
	// Keep SGR while cutting visible cells so tmux capture colours survive.
	const keep = w <= 1 ? w : w - 1;
	let out = "";
	let cells = 0;
	let i = 0;
	while (i < text.length && cells < keep) {
		if (text[i] === "\u001b" && text[i + 1] === "[") {
			const rest = text.slice(i);
			const match = rest.match(LEADING_SGR);
			if (match) {
				out += match[0];
				i += match[0].length;
				continue;
			}
		}
		out += must(text[i]);
		cells += 1;
		i += 1;
	}
	if (w <= 1) return out;
	const reset = text.includes("\u001b[") ? "\u001b[0m" : "";
	return `${out}…${reset}`;
}

/** SGR run at the very start of a slice; see ansi.ts for the shared strippers. */
const LEADING_SGR = new RegExp(`^${String.fromCharCode(27)}\\[[0-9;]*m`, "u");

function paint(text: string, accent: AccentName, enabled: boolean): string {
	if (!enabled || accent === "none") return text;
	return `${ACCENT[accent]}${text}${ACCENT.reset}`;
}

/**
 * An ink card: heavy outline plus a hard offset shadow, the sticker look the
 * design contract asks for instead of Material elevation.
 *
 * Returns `body.length + 3` lines (top rule, body, bottom rule, shadow row)
 * unless `flat`, which drops the shadow row.
 */
export function inkCard(
	body: readonly string[],
	options: CardOptions,
): string[] {
	const colour = colourEnabled();
	const accent = options.accent ?? "none";
	const shadowCols = options.flat ? 0 : 1;
	const outer = Math.max(8, Math.trunc(options.width));
	// Frame occupies outer - shadow column; interior loses the two verticals.
	const frameWidth = outer - shadowCols;
	const inner = frameWidth - 2;

	const titleText = options.title ? ` ${options.title} ` : "";
	const titleFit =
		titleText.length > 0 && titleText.length <= inner - 2 ? titleText : "";
	const rule =
		titleFit.length > 0
			? `${INK.horizontal}${titleFit}${INK.horizontal.repeat(inner - titleFit.length - 1)}`
			: INK.horizontal.repeat(inner);

	const lines: string[] = [];
	lines.push(
		fitCells(
			paint(`${INK.topLeft}${rule}${INK.topRight}`, accent, colour) +
				(shadowCols ? " " : ""),
			outer,
		),
	);
	for (const row of body) {
		const content = fitCells(row, inner);
		lines.push(
			fitCells(
				paint(INK.vertical, accent, colour) +
					content +
					paint(INK.vertical, accent, colour) +
					(shadowCols ? INK.shadow : ""),
				outer,
			),
		);
	}
	lines.push(
		fitCells(
			paint(
				`${INK.bottomLeft}${INK.horizontal.repeat(inner)}${INK.bottomRight}`,
				accent,
				colour,
			) + (shadowCols ? INK.shadow : ""),
			outer,
		),
	);
	if (shadowCols) {
		// Shadow row is offset one cell right — the hard sticker drop.
		lines.push(fitCells(` ${INK.shadow.repeat(frameWidth)}`, outer));
	}
	return lines;
}

/** Colour is opt-out via NO_COLOR and only ever used for rare accents. */
export function colourEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
	if (env.HOBO_CODE_NO_COLOR === "1") return false;
	return true;
}

/**
 * Centre a block of art inside `width`, preserving its internal spacing.
 * Used for the Chewy title card and Bo.
 */
export function centreBlock(art: readonly string[], width: number): string[] {
	const rows = art.map((line) => line.trimEnd());
	let inkLeft = Number.POSITIVE_INFINITY;
	let inkRight = 0;
	for (const line of rows) {
		const start = line.search(/\S/u);
		if (start < 0) continue;
		inkLeft = Math.min(inkLeft, start);
		inkRight = Math.max(inkRight, line.length);
	}
	if (!Number.isFinite(inkLeft)) {
		return rows.map((line) => fitCells(line, width));
	}
	const box = inkRight - inkLeft;
	const pad = Math.max(0, Math.floor((width - box) / 2));
	return rows.map((line) =>
		fitCells(`${" ".repeat(pad)}${line.slice(inkLeft)}`, width),
	);
}

/**
 * Title card: the Chewy wordmark framed like a cartoon opening card.
 * Shown once on entry and then left in the scrollback — it is a moment, not
 * a permanent header that eats half the viewport.
 */
export function titleCard(
	logoArt: string,
	options: {
		readonly width: number;
		readonly subtitle?: string;
		/** Drop the shadow when the card is nested inside another card. */
		readonly flat?: boolean;
	},
): string[] {
	const outer = Math.max(24, Math.trunc(options.width));
	const inner = outer - (options.flat ? 2 : 3);
	const art = centreBlock(
		logoArt.split("\n").filter((l) => l.trim().length > 0),
		inner,
	);
	const body = [...art];
	if (options.subtitle) {
		body.push(fitCells("", inner));
		body.push(...centreBlock([options.subtitle], inner));
	}
	return inkCard(body, {
		width: outer,
		...(options.flat ? { flat: true } : undefined),
	});
}

/**
 * Status stripe — one dense line, inverse-video like a title-card strap.
 * Replaces the old three-line footer stack (brand chip + budget + hints).
 */
export function statusStripe(
	segments: readonly string[],
	width: number,
): string {
	const text = segments.filter((s) => s.length > 0).join("  ·  ");
	const colour = colourEnabled();
	const left = Math.max(0, Math.floor((width - cellWidth(text)) / 2));
	const fitted = fitCells(`${" ".repeat(left)}${text}`, width);
	return colour ? `\u001b[7m${fitted}\u001b[0m` : fitted;
}
