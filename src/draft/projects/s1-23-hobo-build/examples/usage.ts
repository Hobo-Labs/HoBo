/**
 * Runnable example for s1-23-hobo-build (HOBO-613). The draft-artifact gate EXECUTES this
 * with `node --import tsx` and diffs stdout against usage.expected.txt — keep both honest.
 *
 * Demonstrates the real `hobo build` draft contract: a fixture project is built through
 * `runBuild`, the wasm artifact digest must equal BOTH the direct @hobo/componentize path
 * and the committed golden S0-07 fixture (test/fixtures/hello-bindle.digest.json), the
 * non-wasm service falls back to a declared OCI artifact, builds are reproducible, and
 * stale `_generated/` trees fail closed with HOBO_BUILD_CODEGEN_DRIFT.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { componentizeHelloBindle } from "../../../../../packages/componentize/src/index.ts";
import {
	executeCodegenRequest,
	generateCodegenArtifacts,
} from "../../../technical-proofs/hobo-codegen-cli-contract/src/codegen-cli-contract.ts";
import { BuildError, createBuildCli, runBuild, writeBuildFixtureProject } from "../src/index.ts";
import { type JsonValue } from "../src/json.js";


// SAFETY: `const GOLDEN = JSON.parse(` is required at this I/O or test boundary.
const GOLDEN = JSON.parse(
	readFileSync(new URL("../test/fixtures/hello-bindle.digest.json", import.meta.url), "utf8"),
) as { service: string; digest: string; sourceDateEpoch: string; witWorld: string };

const HELLO_BINDLE_SOURCE = fileURLToPath(
	new URL(
		"../../../../../packages/componentize/test/fixtures/hello-bindle/src/service.ts",
		import.meta.url,
	),
);

const projectRoot = await mkdtemp(join(tmpdir(), "hobo-build-usage-"));
try {
	// 1) Materialize the fixture project: hello-bindle (ts/wasm) + legacy-worker (python/container).
	await writeBuildFixtureProject(projectRoot);
	await executeCodegenRequest({
		projectRoot,
		check: false,
		guestLanguage: "ts",
		engine: generateCodegenArtifacts,
	});
	const target = join(projectRoot, "services/hello-bindle/src/service.ts");
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, await readFile(HELLO_BINDLE_SOURCE, "utf8"));
	console.log("fixture project ready: services=hello-bindle(ts/wasm),legacy-worker(python/container)");

	// 2) runBuild produces one artifact per service, deterministically.
	const result = await runBuild({
		json: true,
		projectRoot,
		targetRuntime: "auto",
		sourceDateEpoch: GOLDEN.sourceDateEpoch,
	});
	for (const artifact of result.artifacts) {
		console.log(
			`artifact: service=${artifact.service} kind=${artifact.kind} runtime=${artifact.runtime}` +
				(artifact.fallbackReason ? ` fallback="${artifact.fallbackReason}"` : ""),
		);
	}

	// 3) Digest parity: build path === direct componentize path === committed golden fixture.
	const hello = result.artifacts.find((artifact) => artifact.service === "hello-bindle");
	assert.ok(hello, "hello-bindle artifact produced");
	const direct = await componentizeHelloBindle({
		sourceRoot: join(projectRoot, "services/hello-bindle"),
		sourceDateEpoch: GOLDEN.sourceDateEpoch,
	});
	assert.equal(hello.digest, direct.component.digest, "build path matches direct componentize");
	assert.equal(hello.digest, GOLDEN.digest, "digest matches golden S0-07 fixture");
	assert.equal(hello.witWorld, GOLDEN.witWorld, "wit world matches golden fixture");
	console.log(`digest parity held: ${hello.digest}`);

	// 4) Reproducibility: a second build of the same tree yields the same manifest digest.
	const rebuild = await runBuild({
		json: true,
		projectRoot,
		targetRuntime: "auto",
		sourceDateEpoch: GOLDEN.sourceDateEpoch,
	});
	assert.equal(rebuild.manifestDigest, result.manifestDigest, "manifest digest is reproducible");
	console.log(`manifest reproducible: ${result.manifestDigest === rebuild.manifestDigest}`);

	// 5) The CLI envelope carries the same artifacts as the library path.
	const cli = await createBuildCli().run(["build", "--json"], {
		cwd: projectRoot,
		env: { ...process.env, SOURCE_DATE_EPOCH: GOLDEN.sourceDateEpoch },
	});
	assert.equal(cli.exitCode, 0);
	// SAFETY: `const envelope = JSON.parse(cli.stdout) as {` is required at this I/O or test boundary.
	const envelope = JSON.parse(cli.stdout) as {
		ok: boolean;
		command: string;
		artifacts: Array<{ service: string; digest: string }>;
	};
	const cliHello = envelope.artifacts.find((artifact) => artifact.service === "hello-bindle");
	assert.equal(cliHello?.digest, GOLDEN.digest, "CLI envelope digest matches golden fixture");
	console.log(`cli envelope: ok=${envelope.ok} command=${envelope.command} artifacts=${envelope.artifacts.length}`);

	// 6) Stale generated tree fails closed: drift is a typed BuildError, not a silent build.
	const generatedManifest = join(projectRoot, ".hobo/generated/codegen-manifest.json");
	await writeFile(generatedManifest, `${await readFile(generatedManifest, "utf8")}\n// stale edit\n`);
	const drift = await runBuild({
		json: true,
		projectRoot,
		targetRuntime: "auto",
		sourceDateEpoch: GOLDEN.sourceDateEpoch,
	}).then(
		() => {
			throw new Error("expected drift failure");
		},
		(error: JsonValue) => {
			assert.ok(error instanceof BuildError);
			return error;
		},
	);
	console.log(`stale _generated rejected: code=${drift.code}`);

	console.log("CONTRACT HELD: hobo build is digest-stable, fallback-aware, and refuses stale codegen");
} finally {
	await rm(projectRoot, { recursive: true, force: true });
}
