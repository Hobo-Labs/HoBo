/**
 * The Worker as Cloudflare receives it: the compiled `dist/worker/*.js`
 * modules (ES modules, Web platform only, relative imports only), uploaded
 * as one multipart script with a Durable Object binding and the migration
 * that creates its SQLite-backed class.
 */
import { readdir, readFile } from "node:fs/promises";

// public-contract: the Durable Object class the migration creates; renaming it needs a rename migration.
export const CONFIG_STORE_CLASS = "ConfigStore";
// public-contract: the namespace binding the Worker reads as env.CONFIG_STORE.
export const CONFIG_STORE_BINDING = "CONFIG_STORE";
// public-contract: the first (and so far only) migration tag.
export const CONFIG_STORE_MIGRATION_TAG = "v1";
// public-contract: the plain-text variable that carries the deploy-time binding.
export const CONFIG_BINDING_VAR = "HOBO_CONFIG_BINDING";
// public-contract: the plain-text variable the owner sets after the claim to name their Access application.
export const OWNER_ACCESS_VAR = "HOBO_CONFIG_OWNER_ACCESS";
// public-contract: the Workers compatibility date the modules are written against.
export const CONFIG_SERVICE_COMPATIBILITY_DATE = "2026-07-01";
// public-contract: the entry module's name in the upload.
export const CONFIG_SERVICE_MAIN_MODULE = "index.js";

export type WorkerModule = Readonly<{ name: string; source: string }>;

const MODULE_NAME = /^[a-z][a-z0-9-]*\.js$/u;
const IMPORT =
	/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)|\bimport\s+"([^"]+)"/gu;

/**
 * The compiled modules, source maps stripped. Refuses a module that imports
 * anything but a sibling module: the upload carries no other code.
 */
export async function configServiceWorkerModules(
	directory: URL = new URL("./worker/", import.meta.url),
): Promise<readonly WorkerModule[]> {
	const names = (await readdir(directory))
		.filter((name) => name.endsWith(".js"))
		.sort();
	const modules: WorkerModule[] = [];
	for (const name of names) {
		if (!MODULE_NAME.test(name))
			throw new Error(
				`config-service Worker module ${name} has an unexpected name`,
			);
		const source = (await readFile(new URL(name, directory), "utf8")).replace(
			/^\/\/# sourceMappingURL=.*$/gmu,
			"",
		);
		for (const match of source.matchAll(IMPORT)) {
			const target = match[1] ?? match[2] ?? match[3] ?? "";
			if (!target.startsWith("./") || !names.includes(target.slice(2)))
				throw new Error(
					`config-service Worker module ${name} imports ${target}, which is not one of its sibling modules`,
				);
		}
		modules.push(Object.freeze({ name, source }));
	}
	if (!modules.some((module) => module.name === CONFIG_SERVICE_MAIN_MODULE))
		throw new Error("config-service Worker build is missing its main module");
	return Object.freeze(modules);
}
