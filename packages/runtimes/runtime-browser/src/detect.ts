import type {
	BrowserPersistenceDetection,
	BrowserPersistenceDetectOptions,
} from "./types.js";

export function hasOpfs(): boolean {
	const storage = globalThis.navigator?.storage;
	return storage !== undefined && storage.getDirectory instanceof Function;
}

/**
 * Detect browser storage capabilities without assuming OPFS is present.
 * Checked 2026-07-27 against SQLite WASM OPFS guidance:
 * https://sqlite.org/wasm/doc/trunk/persistence.md
 */
export function detectBrowserPersistence(
	options: BrowserPersistenceDetectOptions,
): BrowserPersistenceDetection {
	const hasWorker = "Worker" in globalThis;
	if (!hasWorker && process === undefined) {
		// Node test harness may not define Worker; treat as transient when allowed
	}

	const opfs = hasOpfs();

	if (opfs) {
		return {
			mode: options.multiTab ? "opfs-sahpool" : "opfs-sahpool",
		};
	}

	if (options.allowTransient) {
		return {
			mode: "transient-memory",
			reason: "OPFS unavailable; transient in-memory mode allowed by policy",
		};
	}

	return {
		mode: "unavailable",
		reason: "OPFS unavailable and durable persistence required",
	};
}
