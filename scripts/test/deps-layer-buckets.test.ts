import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DEPS_LAYER_BUCKET_COUNT,
	DEPS_LAYER_DOCKERFILE_PATH,
	depsLayerBucket,
	partitionDepsLayerEntries,
	syncDepsLayerDockerfile,
} from "../ci/deps-layer-buckets.mts";

const root = join(import.meta.dirname, "..", "..");

describe("deps layer bucket partition", () => {
	it("uses a stable SHA-256 assignment", () => {
		assert.equal(depsLayerBucket("a"), 18);
		assert.equal(depsLayerBucket("b"), 22);
		assert.equal(
			depsLayerBucket("package@1.0.0"),
			depsLayerBucket("package@1.0.0"),
		);
	});

	it("puts every entry in exactly one bucket, in deterministic order", () => {
		const entries = Array.from(
			{ length: 256 },
			(_, index) => `package-${index}@1.0.0+peer-${index % 7}`,
		);
		const buckets = partitionDepsLayerEntries([...entries].reverse());
		assert.equal(buckets.length, DEPS_LAYER_BUCKET_COUNT);
		assert.deepEqual(buckets.flat().sort(), [...entries].sort());
		for (const bucket of buckets) assert.deepEqual(bucket, [...bucket].sort());
	});

	it("changes only the new entry's bucket when one entry is added", () => {
		const entries = Array.from(
			{ length: 128 },
			(_, index) => `package-${index}@1.0.0`,
		);
		const added = "added-package@2.0.0";
		const before = partitionDepsLayerEntries(entries);
		const after = partitionDepsLayerEntries([...entries, added]);
		const changed: number[] = [];
		for (const [index, bucket] of after.entries()) {
			if (JSON.stringify(bucket) !== JSON.stringify(before[index]))
				changed.push(index);
		}
		assert.deepEqual(changed, [depsLayerBucket(added)]);
	});

	it("moves store directories and leaves residual pnpm metadata behind", () => {
		const fixture = mkdtempSync(join(tmpdir(), "hobo-deps-buckets-"));
		try {
			const deps = join(fixture, "deps");
			const buckets = join(fixture, "buckets");
			const store = join(deps, "node_modules", ".pnpm");
			mkdirSync(join(store, "a"), { recursive: true });
			mkdirSync(join(store, "b"), { recursive: true });
			writeFileSync(join(store, "lock.yaml"), "lockfileVersion: 9\n");
			execFileSync(process.execPath, [
				"--experimental-strip-types",
				join(root, "scripts/ci/deps-layer-buckets.mts"),
				"partition",
				deps,
				buckets,
			]);
			for (const entry of ["a", "b"]) {
				assert.ok(
					existsSync(
						join(
							buckets,
							String(depsLayerBucket(entry)).padStart(2, "0"),
							"node_modules",
							".pnpm",
							entry,
						),
					),
				);
				assert.ok(!existsSync(join(store, entry)));
			}
			assert.equal(
				readFileSync(join(store, "lock.yaml"), "utf8"),
				"lockfileVersion: 9\n",
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
});

describe("deps Dockerfile generation", () => {
	it("matches the generator and has 64 bucket layers plus one residual layer", () => {
		const dockerfile = readFileSync(
			join(root, DEPS_LAYER_DOCKERFILE_PATH),
			"utf8",
		);
		assert.equal(syncDepsLayerDockerfile(dockerfile), dockerfile);
		assert.equal(dockerfile.match(/^COPY --link --from=install/gm)?.length, 65);
		for (let bucket = 0; bucket < DEPS_LAYER_BUCKET_COUNT; bucket += 1)
			assert.ok(
				dockerfile.includes(`deps-buckets/${String(bucket).padStart(2, "0")}/`),
			);
	});
});
