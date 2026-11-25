/**
 * Per-station layout persistence — NODE-ONLY ENTRY.
 *
 * This module imports `node:fs`/`node:os`/`node:path` and is deliberately kept
 * out of `src/index.ts` so the core package surface stays pure (no I/O).
 * Import it explicitly via the `@hobo/yard-world/layout-store` subpath from
 * node-side hosts only.
 *
 * Layouts live as JSON under `<YARD_WORLD_HOME>/layouts/<stationId>.json`
 * (default home: `~/.hobo-yard-world/`). Writes are atomic (tmp file + rename)
 * and debounced so a burst of editor drags coalesces into one disk write.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorldLayout } from "./layout-model.js";

export const LAYOUT_SAVE_DEBOUNCE_MS = 200;

export function defaultWorldHome(): string {
	return process.env.YARD_WORLD_HOME ?? join(homedir(), ".hobo-yard-world");
}

function stationFileName(stationId: string): string {
	return `${encodeURIComponent(stationId)}.json`;
}

export class LayoutStore {
	readonly dir: string;
	private readonly pending = new Map<
		string,
		{ layout: WorldLayout; timer: NodeJS.Timeout }
	>();

	constructor(home: string = defaultWorldHome()) {
		this.dir = join(home, "layouts");
	}

	pathFor(stationId: string): string {
		return join(this.dir, stationFileName(stationId));
	}

	/** Load a persisted layout; undefined when absent or unreadable/corrupt. */
	load(stationId: string): WorldLayout | undefined {
		try {
			const raw = readFileSync(this.pathFor(stationId), "utf8");
			const parsed = JSON.parse(raw) as WorldLayout;
			if (typeof parsed !== "object" || parsed === null) return undefined;
			return parsed;
		} catch {
			return undefined;
		}
	}

	/** Atomic write: serialize to a tmp sibling, then rename over the target. */
	saveNow(stationId: string, layout: WorldLayout): void {
		mkdirSync(this.dir, { recursive: true });
		const target = this.pathFor(stationId);
		const tmp = `${target}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(layout, null, 2)}\n`, "utf8");
		renameSync(tmp, target);
	}

	/** Debounced save — rapid editor changes coalesce into one write. */
	saveDebounced(
		stationId: string,
		layout: WorldLayout,
		ms = LAYOUT_SAVE_DEBOUNCE_MS,
	): void {
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
		for (const [stationId, entry] of [...this.pending.entries()]) {
			clearTimeout(entry.timer);
			this.pending.delete(stationId);
			this.saveNow(stationId, entry.layout);
		}
	}
}
