import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEPS_LAYER_BUCKET_COUNT = 64;
export const DEPS_LAYER_DOCKERFILE_PATH =
	"packages/ci-gh-actions/deploy/ci-runner/deps/Dockerfile";

const begin =
	"# BEGIN GENERATED DEPS BUCKET LAYERS: scripts/ci/deps-layer-buckets.mts";
const end = "# END GENERATED DEPS BUCKET LAYERS";
export function depsLayerBucket(entry: string): number {
	if (
		!entry ||
		entry === "." ||
		entry === ".." ||
		entry.includes("/") ||
		entry.includes("\\") ||
		entry.includes("\0")
	)
		throw new Error(`invalid pnpm store entry: ${entry}`);
	return (
		createHash("sha256").update(entry).digest().readUInt32BE(0) %
		DEPS_LAYER_BUCKET_COUNT
	);
}

export function partitionDepsLayerEntries(
	entries: readonly string[],
): readonly (readonly string[])[] {
	const buckets: string[][] = Array.from(
		{ length: DEPS_LAYER_BUCKET_COUNT },
		() => [],
	);
	for (const entry of [...entries].sort()) {
		const bucket = buckets[depsLayerBucket(entry)];
		if (!bucket) throw new Error("deps layer bucket is out of range");
		bucket.push(entry);
	}
	return buckets;
}

export function renderDepsLayerBucketCopies(): string {
	const lines = [begin];
	for (let bucket = 0; bucket < DEPS_LAYER_BUCKET_COUNT; bucket += 1) {
		lines.push(
			"COPY --link --from=install --chown=1000:1000 \\",
			`  /opt/hobo-deps-buckets/${String(bucket).padStart(2, "0")}/ \\`,
			"  /opt/hobo-deps/",
		);
	}
	lines.push(end);
	return lines.join("\n");
}

export function syncDepsLayerDockerfile(source: string): string {
	const start = source.indexOf(begin);
	const finish = source.indexOf(end);
	if (start < 0 || finish < start)
		throw new Error("deps Dockerfile generated-section markers are missing");
	return `${source.slice(0, start)}${renderDepsLayerBucketCopies()}${source.slice(finish + end.length)}`;
}

function partitionDirectory(depsRoot: string, bucketRoot: string): void {
	const store = join(depsRoot, "node_modules", ".pnpm");
	const entries = readdirSync(store, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	const buckets = partitionDepsLayerEntries(entries);
	for (const [index, bucket] of buckets.entries()) {
		const destination = join(
			bucketRoot,
			String(index).padStart(2, "0"),
			"node_modules",
			".pnpm",
		);
		mkdirSync(destination, { recursive: true });
		for (const entry of bucket)
			renameSync(join(store, entry), join(destination, entry));
	}
}

function main(args: readonly string[]): void {
	const [command, ...rest] = args;
	if (command === "partition") {
		if (rest.length !== 2 || !rest[0] || !rest[1])
			throw new Error("usage: partition <deps-root> <bucket-root>");
		partitionDirectory(rest[0], rest[1]);
		return;
	}
	if (command !== "--check" && command !== "--write")
		throw new Error(
			"usage: [--check|--write] or partition <deps-root> <bucket-root>",
		);
	const path = join(process.cwd(), DEPS_LAYER_DOCKERFILE_PATH);
	const source = readFileSync(path, "utf8");
	const generated = syncDepsLayerDockerfile(source);
	if (command === "--check") {
		if (generated !== source)
			throw new Error(
				"deps Dockerfile bucket layers are stale; run node --experimental-strip-types scripts/ci/deps-layer-buckets.mts --write",
			);
		return;
	}
	writeFileSync(path, generated);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
