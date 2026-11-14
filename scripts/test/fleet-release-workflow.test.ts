/**
 * O32 (design §10.1), second half: the release workflow builds, attests and
 * adds a bill of materials for each of the three images L23 defines (the
 * fleet authority, the witness and the peer-to-peer relay; R18). The images
 * are published the way every other release image is: built, exported as an
 * OCI image layout, and promoted as release Freight through `hobo deploy`,
 * whose realizer is the only thing that pushes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
	parseServiceImageId,
	SERVICE_IMAGE_IDS,
	SERVICE_IMAGES,
	serviceImageBuildArgs,
	serviceImageCandidateTag,
	serviceImageDockerfile,
	shipsServiceImages,
} from "../ci/push-release-service-image.mts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const workflow = read(".github/workflows/release-hobo.yml");
const attestAction = read(".github/actions/release-oci-attest/action.yml");

/** The text of one top-level job, up to the next job. */
function job(id: string): string {
	const start = workflow.indexOf(`\n  ${id}:\n`);
	assert.notEqual(start, -1, `release-hobo.yml has no ${id} job`);
	const rest = workflow.slice(start + 1);
	const next = rest.slice(1).search(/\n {2}[a-z0-9_-]+:\n/u);
	return next === -1 ? rest : rest.slice(0, next + 1);
}

const L23_IMAGES = [
	"hobo-fleet-authority",
	"hobo-fleet-witness",
	"hobo-fleet-relay",
] as const;

describe("the release workflow's fleet service images", () => {
	const block = job("release-service-images");

	it("builds one leg per image L23 defines, one at a time", () => {
		assert.deepEqual([...SERVICE_IMAGE_IDS], [...L23_IMAGES]);
		assert.match(
			block,
			/ {8}image_id: \[hobo-fleet-authority, hobo-fleet-witness, hobo-fleet-relay\]\n/u,
		);
		assert.match(block, /max-parallel: 1/u);
		assert.match(block, /fail-fast: false/u);
	});

	it("builds each image from its Dockerfile and publishes it as release Freight", () => {
		assert.match(
			block,
			/run: node --no-warnings scripts\/ci\/push-release-service-image\.mts \$\{\{ matrix\.image_id \}\} "\$\{RUNNER_TEMP\}\/hobo-service-digest\.txt"/u,
		);
		// Through hobo deploy, like release-publish: the restored hobo CLI and a Freight home.
		assert.match(block, /HOBO_RELEASE_CD_HOME: /u);
		assert.match(
			block,
			/scripts\/ci\/release-freight-cli\.mts restore .* --digest "\$HOBO_RELEASE_CLI_DIGEST"/u,
		);
		assert.doesNotMatch(block, /docker push/u);
		for (const id of L23_IMAGES) {
			const args = serviceImageBuildArgs({
				id,
				toolchain: "hobo-ci-worker:local",
				version: "1.0.0",
				revision: "abc",
				contextDir: "/ctx",
			});
			assert.equal(args[0], "build");
			assert.equal(
				args[args.indexOf("-f") + 1],
				join(REPO_ROOT, `deploy/release-images/${id}/Dockerfile`),
			);
			assert.equal(
				serviceImageDockerfile(id),
				`deploy/release-images/${id}/Dockerfile`,
			);
			for (const arg of [
				"HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local",
				"HOBO_RELEASE_VERSION=1.0.0",
				"HOBO_RELEASE_REVISION=abc",
				`io.hobo.release.image=${id}`,
				"org.opencontainers.image.revision=abc",
				"org.opencontainers.image.version=1.0.0",
			])
				assert.ok(args.includes(arg), `${id}: ${arg}`);
			assert.deepEqual(args.slice(-3), [
				"-t",
				serviceImageCandidateTag(id),
				"/ctx",
			]);
			assert.equal(serviceImageCandidateTag(id), `${id}:candidate`);
		}
	});

	it("attests build provenance and a bill of materials for the digest it published", () => {
		const attest = block.slice(
			block.indexOf("uses: ./.github/actions/release-oci-attest"),
		);
		assert.match(
			attest,
			/digest-list-path: \$\{\{ runner\.temp \}\}\/hobo-service-digest\.txt/u,
		);
		assert.match(attest, /image-id: \$\{\{ matrix\.image_id \}\}/u);
		assert.match(attest, /ghcr-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u);
		// The attestation runs only once a digest was recorded, and a missing one fails the leg.
		assert.match(block, /if: steps\.digest\.outputs\.present == 'true'/u);
		assert.match(block, /if \[ ! -s "\$\{DIGEST_FILE\}" \]; then/u);
		// The shared action: provenance first, then a CycloneDX SBOM attested as such.
		assert.ok(
			attestAction.indexOf("actions/attest-build-provenance@") <
				attestAction.indexOf("cyclonedx-json="),
		);
		assert.ok(
			attestAction.indexOf("cyclonedx-json=") <
				attestAction.indexOf("actions/attest-sbom@"),
		);
	});

	it("holds exactly the permissions attestation needs", () => {
		for (const permission of [
			"contents: read",
			"packages: write",
			"id-token: write",
			"attestations: write",
		])
			assert.ok(block.includes(`      ${permission}\n`), permission);
		assert.doesNotMatch(block, /write-all|contents: write/u);
		assert.match(block, /environment: release/u);
	});

	it("runs for the full train only, after the release images built, and never on always()", () => {
		const condition =
			/^ {4}if: >-\n([\s\S]*?)\n {4}needs:/mu.exec(block)?.[1] ?? "";
		assert.match(condition, /^\s*!cancelled\(\) &&/u);
		assert.doesNotMatch(condition, /\balways\(\)/u);
		assert.match(
			condition,
			/needs\.release-oci-build-tag\.result == 'success'/u,
		);
		assert.match(condition, /needs\.release-hobo-cli\.result == 'success'/u);
		assert.match(condition, /!startsWith\(github\.ref, 'refs\/tags\/sdk-v'\)/u);
		assert.match(condition, /!startsWith\(github\.ref, 'refs\/tags\/cli-v'\)/u);
		assert.match(
			block,
			/ {4}needs: \[release-main-train-gate, release-oci-build-tag, release-hobo-cli\]\n/u,
		);
		assert.equal(shipsServiceImages("v0.1.0"), true);
		assert.equal(shipsServiceImages("v0.0.0-alpha.12"), true);
		assert.equal(shipsServiceImages("sdk-v0.1.0"), false);
		assert.equal(shipsServiceImages("cli-v0.1.0"), false);
	});

	it("routes without a routing variable (ADR-0181)", () => {
		assert.doesNotMatch(block, /vars\.HOBO_CI_/u);
		assert.doesNotMatch(workflow, /HOBO_CI_TRUNK_RUNNER/u);
	});

	it("keeps its Freight journal out of the train's release tag and GitHub Release", () => {
		// release-tag and release-github read every `hobo-release-freight-oci-*`
		// journal as one of the train's images; these images are not in the train.
		assert.doesNotMatch(block, /hobo-release-freight-oci-/u);
		assert.doesNotMatch(block, /name: hobo-release-digest-/u);
	});

	it("stages the authority's package for the authority and the witness, and nothing for the relay", () => {
		const pkg: { name: string; bin: Record<string, string> } = JSON.parse(
			read("packages/fleet-authority/package.json"),
		);
		for (const id of ["hobo-fleet-authority", "hobo-fleet-witness"] as const) {
			const stage = SERVICE_IMAGES[id].stage;
			assert.equal(stage.packageName, pkg.name);
			assert.equal(stage.appPath, "app");
			for (const wrapper of stage.wrappers)
				assert.equal(`./${wrapper.entrypoint}`, pkg.bin[wrapper.name], id);
			assert.deepEqual(
				stage.wrappers.map(({ name }) => name),
				[id],
			);
		}
		assert.equal(SERVICE_IMAGES["hobo-fleet-relay"].stage, undefined);
	});

	it("publishes nothing on a train that does not ship them, and refuses an unknown image", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-service-image-"));
		try {
			const digest = join(dir, "digest.txt");
			const run = (id: string, ref: string) =>
				spawnSync(
					process.execPath,
					[
						"--no-warnings",
						"scripts/ci/push-release-service-image.mts",
						id,
						digest,
					],
					{
						cwd: REPO_ROOT,
						env: {
							PATH: process.env.PATH ?? "",
							HOBO_RELEASE_VERSION: ref,
							GITHUB_REPOSITORY: "acme/app",
							HOBO_RELEASE_CD_HOME: join(dir, "cd"),
						},
						encoding: "utf8",
					},
				);
			const skipped = run("hobo-fleet-relay", "cli-v0.1.0");
			assert.equal(skipped.status, 0, skipped.stderr);
			assert.equal(readFileSync(digest, "utf8"), "");
			const unknown = run("hobo-fleet-gateway", "v0.1.0");
			assert.notEqual(unknown.status, 0);
			assert.match(unknown.stderr, /unknown service image id/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		assert.throws(
			() => parseServiceImageId("hobo-cli"),
			/unknown service image id/u,
		);
	});
});
