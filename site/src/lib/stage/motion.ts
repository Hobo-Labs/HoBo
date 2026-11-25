const STORE = "hobo-motion";
const EVENT = "hobo:motion";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");

export const prefersStill = (): boolean => reduced.matches;

export const isPaused = (): boolean => document.documentElement.dataset.motion === "still";

export const isStill = (): boolean => prefersStill() || isPaused();

function read(): boolean {
	try {
		return localStorage.getItem(STORE) === "still";
	} catch {
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
	}
	document.dispatchEvent(new CustomEvent(EVENT));
}

export function onMotionChange(listener: () => void): () => void {
	document.addEventListener(EVENT, listener);
	reduced.addEventListener("change", listener);
	return () => {
		document.removeEventListener(EVENT, listener);
		reduced.removeEventListener("change", listener);
	};
}

export function restoreMotion(): void {
	if (read()) document.documentElement.dataset.motion = "still";
}
