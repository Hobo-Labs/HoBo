export type StopIds = { readonly id: string; readonly inner: readonly string[] };

export function hashTarget(hash: string): string {
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export function stopFromHash(hash: string, stops: readonly StopIds[]): number {
	const target = hashTarget(hash);
	if (!target) return -1;
	return stops.findIndex((s) => s.id === target || s.inner.includes(target));
}

export function clampStop(want: number, count: number): number {
	if (count <= 0) return 0;
	return Math.min(count - 1, Math.max(0, want));
}

export function hashForStop(index: number, id: string): string {
	return index === 0 || !id ? "" : `#${id}`;
}

export function inStageZone(scrollY: number, stageHeight: number): boolean {
	return scrollY < stageHeight * 0.5;
}

export function trailTakes(inStage: boolean, dir: number, atStart: boolean, atEnd: boolean): boolean {
	if (!inStage || dir === 0) return false;
	if (dir > 0) return !atEnd;
	return !atStart;
}

export type KeyPlace = "editable" | "sideways" | "page";

export function pageKeepsKey(place: KeyPlace, key: string): boolean {
	if (place === "editable") return true;
	if (place === "sideways") return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
	return false;
}

export function keyDirection(key: string, shift: boolean, fromBody: boolean): number {
	if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown") return 1;
	if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") return -1;
	if (key === " " && fromBody) return shift ? -1 : 1;
	return 0;
}

export function readsDown(key: string): boolean {
	return key === "ArrowDown" || key === "ArrowUp" || key === "PageDown" || key === "PageUp" || key === " ";
}

export function scrollAmount(key: string, viewport: number): number {
	return key === "ArrowDown" || key === "ArrowUp" ? 56 : Math.round(viewport * 0.85);
}

export function canScroll(dir: number, scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
	if (dir > 0) return scrollTop + clientHeight < scrollHeight - 1;
	if (dir < 0) return scrollTop > 1;
	return false;
}

export function moreSides(scrollLeft: number, scrollWidth: number, clientWidth: number): string {
	const sides: string[] = [];
	if (canScroll(-1, scrollLeft, scrollWidth, clientWidth)) sides.push("left");
	if (canScroll(1, scrollLeft, scrollWidth, clientWidth)) sides.push("right");
	return sides.join(" ");
}

export function fits(contentHeight: number, available: number): boolean {
	return contentHeight <= available + 1;
}

export const WHEEL_QUIET_MS = 140;

export function startsGesture(gapMs: number, size: number, last: number, peak: number): boolean {
	if (gapMs > WHEEL_QUIET_MS) return true;
	const decayed = last < peak * 0.6;
	const rising = size > last * 1.5 && size - last > 12;
	return decayed && rising;
}
