#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	buildControllerReleases,
	CONTROLLER_RELEASE_ENTRIES,
	controllerReleaseIndex,
} from "./controller-release.mts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
	options: {
		out: { type: "string", default: join(packageRoot, "dist", "releases") },
		version: { type: "string" },
		"base-url": { type: "string" },
	},
});
const out = resolve(values.out ?? "");
const version =
	values.version ??
	`release-${new Date().toISOString().replace(/\D/gu, "").slice(0, 14)}`;
const Index = z.object({
	items: z.array(
		z.object({
			version: z.string(),
			url: z.string(),
			digest: z.string(),
			size: z.number(),
			mediaType: z.string(),
		}),
	),
});
await mkdir(out, { recursive: true });
const releases = await buildControllerReleases({
	packageRoot,
	entries: CONTROLLER_RELEASE_ENTRIES,
});
for (const release of releases) {
	await writeFile(join(out, release.fileName), release.bytes);
	const indexFile = join(out, `index.${release.artifactName}.json`);
	const existing = await readFile(indexFile, "utf8").then(
		(text) => Index.parse(JSON.parse(text)).items,
		() => [],
	);
	const index = controllerReleaseIndex(release, {
		version,
		baseUrl: values["base-url"],
		existing,
	});
	await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
	process.stdout.write(
		`${JSON.stringify({
			event: "hobo_ci_controller_release_built",
			artifactName: release.artifactName,
			digest: release.digest,
			file: join(out, release.fileName),
			bytes: release.bytes.byteLength,
			version,
		})}\n`,
	);
}
