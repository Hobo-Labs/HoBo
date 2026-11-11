// ==========================================================================
// The trail's decisions, without the DOM.
//
// Everything ./landing.ts has to *decide* — which stop a link names, where a
// step lands, whether a key or a wheel belongs to the trail or to the page,
// whether a stop's content fits — lives here as plain functions, so each one
// can be tested on its own (./trail-logic.test.ts). landing.ts only measures
// and moves.
// ==========================================================================

/** A stop as a link can name it: its own id and the ids inside it. */
export type StopIds = { readonly id: string; readonly inner: readonly string[] };

/** The hash as the reader typed it, decoded where it can be. */
export function hashTarget(hash: string): string {
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	try {
		return decodeURIComponent(raw);
	} catch {
		// A malformed escape is matched as written.
		return raw;
	}
}

/** Which stop a hash names, or -1. A section's own id or any id inside it. */
export function stopFromHash(hash: string, stops: readonly StopIds[]): number {
	const target = hashTarget(hash);
	if (!target) return -1;
	return stops.findIndex((s) => s.id === target || s.inner.includes(target));
}

/** The stop a step lands on: never before the first or past the last. */
export function clampStop(want: number, count: number): number {
	if (count <= 0) return 0;
	return Math.min(count - 1, Math.max(0, want));
}

/** The hash that names a stop. The first stop is the page itself: no hash. */
export function hashForStop(index: number, id: string): string {
	return index === 0 || !id ? "" : `#${id}`;
}

/**
 * Is the trail on screen? It owns the viewport from the top of the page down
 * to its own foot; past that the reader has scrolled on to the footer. A small
 * scroll (a rotated phone, a key that nudged the window) is still the trail.
 */
export function inStageZone(scrollY: number, stageHeight: number): boolean {
	return scrollY < stageHeight * 0.5;
}

/**
 * Does a step in this direction belong to the trail? Not when the reader is
 * down at the footer, and not past either end: there the page's own scroll
 * takes over, so the footer is a normal scroll away.
 */
export function trailTakes(inStage: boolean, dir: number, atStart: boolean, atEnd: boolean): boolean {
	if (!inStage || dir === 0) return false;
	if (dir > 0) return !atEnd;
	return !atStart;
}

/** Where a key event happened, as far as the trail cares. */
export type KeyPlace = "editable" | "sideways" | "page";

/**
 * Does the page keep this key? Anything typed into stays there. A sideways
 * scroller (a code block, a wide table) keeps the keys that scroll it
 * sideways and nothing else, so up and down still move the trail.
 */
export function pageKeepsKey(place: KeyPlace, key: string): boolean {
	if (place === "editable") return true;
	if (place === "sideways") return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
	return false;
}

/** Which way a key moves: +1 on, -1 back, 0 neither. Space only from the page body. */
export function keyDirection(key: string, shift: boolean, fromBody: boolean): number {
	if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown") return 1;
	if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") return -1;
	if (key === " " && fromBody) return shift ? -1 : 1;
	return 0;
}

/** Does the key read the page vertically, so a tall stop scrolls before it steps? */
export function readsDown(key: string): boolean {
	return key === "ArrowDown" || key === "ArrowUp" || key === "PageDown" || key === "PageUp" || key === " ";
}

/** How far one key scrolls a tall stop. */
export function scrollAmount(key: string, viewport: number): number {
	return key === "ArrowDown" || key === "ArrowUp" ? 56 : Math.round(viewport * 0.85);
}

/** Can a scroll box move further this way? Tolerates sub-pixel rounding. */
export function canScroll(dir: number, scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
	if (dir > 0) return scrollTop + clientHeight < scrollHeight - 1;
	if (dir < 0) return scrollTop > 1;
	return false;
}

/** Does a stop's content fit the area it is given? */
export function fits(contentHeight: number, available: number): boolean {
	return contentHeight <= available + 1;
}

/** How long the wheel has to be quiet before the next event is a new gesture. */
export const WHEEL_QUIET_MS = 140;

/**
 * Does this wheel event start a new gesture? It does after a pause, and it
 * does when a stream that was dying away (a flick's inertia) suddenly rises
 * again: that is a second flick, not more of the first. A mouse wheel's even
 * notches never rise like that, and an inertia tail's jitter is too small to.
 */
export function startsGesture(gapMs: number, size: number, last: number, peak: number): boolean {
	if (gapMs > WHEEL_QUIET_MS) return true;
	const decayed = last < peak * 0.6;
	const rising = size > last * 1.5 && size - last > 12;
	return decayed && rising;
}
