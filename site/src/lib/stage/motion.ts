// ==========================================================================
// One switch for everything on the page that moves on its own.
//
// The trail, the travelers who wander onto it and the ones who pop out of the
// page content all read the same answer to "may I move?", so there is no way
// to pause one and leave another running. Two things say no:
//
//   - the reader's `prefers-reduced-motion`, which is not ours to override;
//   - the pause button on the trail, which is remembered between visits.
//
// The remembered choice lives on <html data-motion="still"> so CSS can read
// it too, and anything already mid-flight can land instead of freezing.
// ==========================================================================

const STORE = "hobo-motion";
const EVENT = "hobo:motion";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");

/** The reader has asked for less motion at the OS level. */
export const prefersStill = (): boolean => reduced.matches;

/** The reader has paused the page's own ambient motion. */
export const isPaused = (): boolean => document.documentElement.dataset.motion === "still";

/** Nothing ambient may move right now. */
export const isStill = (): boolean => prefersStill() || isPaused();

function read(): boolean {
	try {
		return localStorage.getItem(STORE) === "still";
	} catch {
		// Storage can be blocked outright; the page then simply forgets.
		return false;
	}
}

export function setPaused(on: boolean): void {
	const root = document.documentElement;
	if (on) root.dataset.motion = "still";
	else delete root.dataset.motion;
	try {
		if (on) localStorage.setItem(STORE, "still");
		else localStorage.removeItem(STORE);
	} catch {
		// Not remembered; still honoured for this visit.
	}
	document.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * Called whenever the choice changes. Returns the way to stop listening, so
 * whatever subscribed can leave without a listener outliving it.
 */
export function onMotionChange(listener: () => void): () => void {
	document.addEventListener(EVENT, listener);
	reduced.addEventListener("change", listener);
	return () => {
		document.removeEventListener(EVENT, listener);
		reduced.removeEventListener("change", listener);
	};
}

/** Apply the remembered choice. Safe to call more than once. */
export function restoreMotion(): void {
	if (read()) document.documentElement.dataset.motion = "still";
}
