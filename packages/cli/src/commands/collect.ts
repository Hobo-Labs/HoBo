import { readFile } from "node:fs/promises";
import path from "node:path";

import {
	type CollectionTarget,
	canonicalManifestHash,
	collectBindleManifest,
	type ManifestV1,
	parseManifest,
	serializeManifest,
} from "@hobo/bindles";

import { stubResult } from "../cloud/stub.js";
import type { JsonObject } from "../json.js";
import type { CommandModule } from "../shell/registry.js";

export const COLLECT_GOLDEN_FILE = "hobo.manifest.json"; // public-contract: golden manifest file name collect writes into the project

export interface CollectCommandDeps {
	readonly target?: CollectionTarget;
	readonly resolveTarget?: (
		projectDir: string,
	) => Promise<CollectionTarget | null>;
}

export function createCollectCommand(
	deps: CollectCommandDeps = {},
): CommandModule {
	return {
		implemented: Boolean(deps.target ?? deps.resolveTarget),
		run: async ({ context, flags, emitProgress }) => {
			const projectDir = context.projectDir ?? context.cwd;
			const target =
				deps.target ?? (await deps.resolveTarget?.(projectDir)) ?? null;
			if (!target) {
				return stubResult("collect");
			}
			emitProgress(
				`hobo collect: running resource collection on ${target.bindleId}`,
			);
			const result = collectBindleManifest(target);
			const manifestValue = JSON.parse(
				serializeManifest(result.manifest),
			) as JsonObject;
			const manifestIr = JSON.stringify(manifestValue, null, 2);

			if (flags.check) {
				const golden = await loadGolden(projectDir);
				if (!golden) {
					return {
						ok: false,
						status: "error",
						code: "HOBO_COLLECT_NO_GOLDEN",
						message: `hobo collect --check: no golden manifest at ${COLLECT_GOLDEN_FILE}`,
						remediation: [
							`Run hobo collect and commit ${COLLECT_GOLDEN_FILE} before enforcing --check.`,
						],
						data: { command: "collect", manifestHash: result.manifestHash },
					};
				}

				const goldenHash = canonicalManifestHash(golden);
				if (goldenHash !== result.manifestHash) {
					return {
						ok: false,
						status: "drift",
						code: "HOBO_COLLECT_DRIFT",
						message: `hobo collect --check: manifest drift\ngolden:    ${goldenHash}\ncollected: ${result.manifestHash}`,
						remediation: [
							`Re-run hobo collect and commit the refreshed ${COLLECT_GOLDEN_FILE}.`,
						],
						data: {
							command: "collect",
							goldenHash,
							manifestHash: result.manifestHash,
							manifest: manifestValue,
						},
					};
				}

				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: `hobo collect --check ok (no drift)\nhash: ${result.manifestHash}`,
					data: {
						command: "collect",
						checked: true,
						manifestHash: result.manifestHash,
						manifest: manifestValue,
					},
				};
			}

			return {
				ok: true,
				status: "ok",
				code: "HOBO_OK",
				message: `hobo collect: ${result.bindleId} (${result.resources.length} resources)\nhash: ${result.manifestHash}\n${manifestIr}`,
				data: {
					command: "collect",
					bindleId: result.bindleId,
					manifestHash: result.manifestHash,
					resources: result.resources,
					binds: result.binds,
					manifest: manifestValue,
					events: result.events,
				},
			};
		},
	};
}

async function loadGolden(projectDir: string): Promise<ManifestV1 | null> {
	let raw: string;
	try {
		raw = await readFile(path.join(projectDir, COLLECT_GOLDEN_FILE), "utf8");
	} catch {
		return null;
	}
	try {
		return parseManifest(JSON.parse(raw));
	} catch {
		return null;
	}
}
