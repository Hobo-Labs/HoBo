/**
 * Durable set of Camp host runtimes enabled on this HOBO_HOME yard.
 * Written by `hobo add runtime-*`; read by broker placement hard-fail.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ComponentHostKind } from "./bare-metal-yard.js";
import { defaultHoboHome } from "./bare-metal-yard.js";
import {
	hostToRuntimeInstallId,
	RUNTIME_INSTALL_IDS,
	type RuntimeInstallId,
	runtimeInstallIdToHost,
} from "./runtime-catalog.js";

export const INSTALLED_RUNTIMES_SCHEMA = "hobo.installed-runtimes/v1" as const;

export interface InstalledRuntimesState {
	readonly schemaVersion: typeof INSTALLED_RUNTIMES_SCHEMA;
	readonly runtimes: readonly RuntimeInstallId[];
	readonly updatedAt: string;
}

export function installedRuntimesPath(hoboHome: string): string {
	return join(hoboHome, "installed-runtimes.json");
}

export function loadInstalledRuntimes(
	hoboHome: string = defaultHoboHome(),
): InstalledRuntimesState {
	const path = installedRuntimesPath(hoboHome);
	if (!existsSync(path)) {
		// Bootstrap: local only until operator installs more.
		return {
			schemaVersion: INSTALLED_RUNTIMES_SCHEMA,
			runtimes: ["runtime-local"],
			updatedAt: new Date(0).toISOString(),
		};
	}
	try {
		// SAFETY: assertion required at this I/O or test boundary.
		const raw = JSON.parse(
			readFileSync(path, "utf8"),
		) as InstalledRuntimesState;
		if (raw.schemaVersion !== INSTALLED_RUNTIMES_SCHEMA) {
			return {
				schemaVersion: INSTALLED_RUNTIMES_SCHEMA,
				runtimes: ["runtime-local"],
				updatedAt: new Date(0).toISOString(),
			};
		}
		const runtimes = raw.runtimes.filter((id): id is RuntimeInstallId =>
			// SAFETY: assertion required at this I/O or test boundary.
			(RUNTIME_INSTALL_IDS as readonly string[]).includes(id),
		);
		if (!runtimes.includes("runtime-local")) {
			runtimes.unshift("runtime-local");
		}
		return {
			schemaVersion: INSTALLED_RUNTIMES_SCHEMA,
			runtimes: Object.freeze([...new Set(runtimes)]),
			updatedAt: raw.updatedAt,
		};
	} catch {
		return {
			schemaVersion: INSTALLED_RUNTIMES_SCHEMA,
			runtimes: ["runtime-local"],
			updatedAt: new Date(0).toISOString(),
		};
	}
}

export function saveInstalledRuntimes(
	state: InstalledRuntimesState,
	hoboHome: string = defaultHoboHome(),
): string {
	mkdirSync(hoboHome, { recursive: true });
	const path = installedRuntimesPath(hoboHome);
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	return path;
}

export function installRuntime(
	id: RuntimeInstallId,
	hoboHome: string = defaultHoboHome(),
): InstalledRuntimesState {
	const current = loadInstalledRuntimes(hoboHome);
	const runtimes = [...new Set([...current.runtimes, id, "runtime-local"])];
	const next: InstalledRuntimesState = {
		schemaVersion: INSTALLED_RUNTIMES_SCHEMA,
		// SAFETY: assertion required at this I/O or test boundary.
		runtimes: Object.freeze(runtimes as RuntimeInstallId[]),
		updatedAt: new Date().toISOString(),
	};
	saveInstalledRuntimes(next, hoboHome);
	return next;
}

export function installedHostKinds(
	hoboHome: string = defaultHoboHome(),
): readonly ComponentHostKind[] {
	return Object.freeze(
		loadInstalledRuntimes(hoboHome)
			.runtimes.map((id) => runtimeInstallIdToHost(id))
			.filter((h): h is ComponentHostKind => h !== undefined),
	);
}

export function isRuntimeInstalled(
	host: ComponentHostKind,
	hoboHome: string = defaultHoboHome(),
): boolean {
	const id = hostToRuntimeInstallId(host);
	return loadInstalledRuntimes(hoboHome).runtimes.includes(id);
}
