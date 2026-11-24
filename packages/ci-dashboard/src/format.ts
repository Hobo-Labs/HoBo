export function escapeHtml(value: string | number): string {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function duration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function ago(atMs: number, nowMs: number): string {
	const minutes = Math.floor((nowMs - atMs) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} days ago`;
}

export function utc(atMs: number): string {
	return `${new Date(atMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function percent(share: number | undefined): string {
	return share === undefined ? "–" : `${Math.round(share * 100)}%`;
}

export function minutes(value: number): string {
	return `${Math.round(value * 10) / 10} min`;
}
