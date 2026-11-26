/**
 * Per-station layout persistence (Phase 2 slice 3).
 *
 * Layouts live as JSON under `<OTEL_OFFICE_HOME>/layouts/<stationId>.json`
 * (default home: `~/.otel-office/`). Writes are atomic (tmp file + rename) and
 * debounced so a burst of editor drags coalesces into one disk write.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OfficeLayout } from "./layout.js";
import { isJsonObject, parseJsonValue, type JsonObject } from "./json.js";


export const LAYOUT_SAVE_DEBOUNCE_MS = 200;

export function defaultOfficeHome(): string {
	return process.env.OTEL_OFFICE_HOME ?? join(homedir(), ".otel-office");
}

function stationFileName(stationId: string): string {
	return `${encodeURIComponent(stationId)}.json`;
}

export class LayoutStore {
	readonly dir: string;
	private readonly pending = new Map<string, { layout: OfficeLayout; timer: NodeJS.Timeout }>();

	constructor(home: string = defaultOfficeHome()) {
		this.dir = join(home, "layouts");
	}

	pathFor(stationId: string): string {
		return join(this.dir, stationFileName(stationId));
	}

	/**
	 * Load a persisted layout as unvalidated JSON; undefined when absent or
	 * unreadable/corrupt. Callers must run `validateLayout` before use — the
	 * store deliberately does not claim the bytes are an OfficeLayout.
	 */
	load(stationId: string): JsonObject | undefined {
		try {
			const raw = readFileSync(this.pathFor(stationId), "utf8");
			const parsed = parseJsonValue(raw);
			return isJsonObject(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	/** Atomic write: serialize to a tmp sibling, then rename over the target. */
	saveNow(stationId: string, layout: OfficeLayout): void {
		mkdirSync(this.dir, { recursive: true });
		const target = this.pathFor(stationId);
		const tmp = `${target}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(layout, null, 2)}\n`, "utf8");
		renameSync(tmp, target);
	}

	/** Debounced save — rapid editor changes coalesce into one write. */
	saveDebounced(stationId: string, layout: OfficeLayout, ms = LAYOUT_SAVE_DEBOUNCE_MS): void {
		const existing = this.pending.get(stationId);
		if (existing !== undefined) clearTimeout(existing.timer);
		const timer = setTimeout(() => {
			this.pending.delete(stationId);
			this.saveNow(stationId, layout);
		}, ms);
		timer.unref();
		this.pending.set(stationId, { layout, timer });
	}

	/** Flush all debounced writes synchronously (shutdown + tests). */
	flush(): void {
		for (const [stationId, entry] of this.pending.entries()) {
			clearTimeout(entry.timer);
			this.pending.delete(stationId);
			this.saveNow(stationId, entry.layout);
		}
	}
}
