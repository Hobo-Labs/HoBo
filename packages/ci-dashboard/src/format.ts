/**
 * Text helpers the views share. Every value a view interpolates into markup
 * passes through `escapeHtml`; times are written in plain words.
 */

export function escapeHtml(value: string | number): string {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** A duration in milliseconds as `42s`, `3m 05s` or `1h 02m`; a dash when unknown. */
export function duration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long before `nowMs` a moment was: `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
export function ago(atMs: number, nowMs: number): string {
	const minutes = Math.floor((nowMs - atMs) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} days ago`;
}

/** An epoch millisecond as a UTC timestamp a person can read and a machine can sort. */
export function utc(atMs: number): string {
	return `${new Date(atMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A share from 0 to 1 as a whole percentage; a dash when unknown. */
export function percent(share: number | undefined): string {
	return share === undefined ? "–" : `${Math.round(share * 100)}%`;
}

/** Minutes with at most one decimal. */
export function minutes(value: number): string {
	return `${Math.round(value * 10) / 10} min`;
}
