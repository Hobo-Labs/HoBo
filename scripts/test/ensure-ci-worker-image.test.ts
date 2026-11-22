import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DEFAULT_WORKER_PULL_BUDGET_SEC,
	materializeCiWorkerImageOnly,
	pullWorkerFromGhcr,
	releaseWorkerEnsurePath,
	remoteWorkerTag,
	resolveWorkerRemoteRef,
	validatedWorkerDigestRef,
	workerPullBudgetSec,
} from "../ci/ensure-ci-worker-image.mts";

describe("ensure-ci-worker-image", () => {
	it("tags GHCR worker refs lower-case", () => {
		assert.equal(
			remoteWorkerTag("Hobo-Labs/HoBo", "vdeadbeefcafe"),
			"ghcr.io/hobo-labs/hobo/hobo-ci-worker:vdeadbeefcafe",
		);
	});

	it("parses one positive pull budget and falls back on junk", () => {
		assert.equal(
			workerPullBudgetSec(undefined),
			DEFAULT_WORKER_PULL_BUDGET_SEC,
		);
		assert.equal(workerPullBudgetSec(" 12 "), 12);
		assert.equal(workerPullBudgetSec("001"), 1);
		for (const junk of [
			"",
			"soon",
			"0",
			"-1",
			"1.5",
			"1e3",
			"999999999999999999999",
		])
			assert.equal(workerPullBudgetSec(junk), DEFAULT_WORKER_PULL_BUDGET_SEC);
	});

	it("accepts only this repository's lowercase immutable worker ref", () => {
		const digest = `sha256:${"a".repeat(64)}`;
		const valid = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@${digest}`;
		assert.equal(validatedWorkerDigestRef("Hobo-Labs/HoBo", valid), valid);
		for (const invalid of [
			undefined,
			"garbage",
			"ghcr.io/hobo-labs/hobo/hobo-ci-worker:vdeadbeefcafe",
			`ghcr.io/other/repo/hobo-ci-worker@${digest}`,
			`ghcr.io/hobo-labs/hobo/other-image@${digest}`,
			`ghcr.io/Hobo-Labs/HoBo/hobo-ci-worker@${digest}`,
			`${valid}:extra`,
		])
			assert.equal(validatedWorkerDigestRef("Hobo-Labs/HoBo", invalid), null);
	});

	it("falls back to the version tag only when the ref variable is absent", () => {
		const digest = `sha256:${"b".repeat(64)}`;
		const valid = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@${digest}`;
		assert.equal(
			resolveWorkerRemoteRef("Hobo-Labs/HoBo", "vdeadbeef", {}),
			"ghcr.io/hobo-labs/hobo/hobo-ci-worker:vdeadbeef",
		);
		assert.equal(
			resolveWorkerRemoteRef("Hobo-Labs/HoBo", "vdeadbeef", {
				HOBO_CI_WORKER_IMAGE_REF: valid,
			}),
			valid,
		);
	});

	it("throws on a supplied ref that is empty, malformed, or for another image", () => {
		const digest = `sha256:${"b".repeat(64)}`;
		const valid = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@${digest}`;
		const invalid = [
			"",
			"   ",
			`ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"b".repeat(63)}`,
			`ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"B".repeat(64)}`,
			"ghcr.io/hobo-labs/hobo/hobo-ci-worker:vdeadbeef",
			`ghcr.io/other/repo/hobo-ci-worker@${digest}`,
			`ghcr.io/hobo-labs/hobo/other-image@${digest}`,
			`ghcr.io/Hobo-Labs/HoBo/hobo-ci-worker@${digest}`,
			`${valid}:extra`,
		];
		for (const value of invalid) {
			let thrown: unknown;
			try {
				resolveWorkerRemoteRef("Hobo-Labs/HoBo", "vdeadbeef", {
					HOBO_CI_WORKER_IMAGE_REF: value,
				});
			} catch (error) {
				thrown = error;
			}
			assert.ok(
				thrown instanceof Error,
				`expected ${JSON.stringify(value)} to throw`,
			);
			assert.match(thrown.message, /HOBO_CI_WORKER_IMAGE_REF/u);
			assert.doesNotMatch(thrown.message, /token/iu);
		}
	});

	it("retries a failed pull within the remaining shared budget", () => {
		const bin = mkdtempSync(join(tmpdir(), "hobo-worker-retry-"));
		const calls = join(bin, "calls");
		const once = join(bin, "failed-once");
		writeFileSync(
			join(bin, "timeout"),
			[
				"#!/bin/sh",
				`echo "timeout $*" >> "${calls}"`,
				'seconds="$1"; shift; "$@"',
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(
			join(bin, "docker"),
			[
				"#!/bin/sh",
				`if [ "$1" = pull ] && [ ! -f "${once}" ]; then : > "${once}"; exit 1; fi`,
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		try {
			process.env.PATH = `${bin}:${previousPath ?? ""}`;
			assert.equal(
				pullWorkerFromGhcr("ghcr.io/hobo-labs/hobo/hobo-ci-worker:v1", {
					attempts: 2,
					budgetSec: 30,
					random: () => 0,
				}),
				true,
			);
			const recorded = readFileSync(calls, "utf8");
			assert.equal(recorded.match(/ docker pull /gu)?.length, 2);
			assert.match(recorded, /^timeout 30 docker pull /u);
		} finally {
			process.env.PATH = previousPath;
			rmSync(bin, { recursive: true, force: true });
		}
	});

	it("never starts another pull after the shared deadline", () => {
		const bin = mkdtempSync(join(tmpdir(), "hobo-worker-deadline-"));
		const calls = join(bin, "calls");
		writeFileSync(
			join(bin, "timeout"),
			[
				"#!/bin/sh",
				`echo "timeout $*" >> "${calls}"`,
				'seconds="$1"; shift; "$@"',
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const previousPath = process.env.PATH;
		const times = [0, 0, 2000];
		try {
			process.env.PATH = `${bin}:${previousPath ?? ""}`;
			assert.equal(
				pullWorkerFromGhcr("ghcr.io/hobo-labs/hobo/hobo-ci-worker:v1", {
					attempts: 4,
					budgetSec: 1,
					now: () => times.shift() ?? 2000,
					random: () => 0,
				}),
				false,
			);
			const recorded = readFileSync(calls, "utf8");
			assert.equal(recorded.match(/ docker pull /gu)?.length, 1);
			assert.match(recorded, /^timeout 1 docker pull /u);
		} finally {
			process.env.PATH = previousPath;
			rmSync(bin, { recursive: true, force: true });
		}
	});

	function resolveDigestWithStub(manifest: boolean) {
		const bin = mkdtempSync(join(tmpdir(), "hobo-worker-resolve-"));
		try {
			const calls = join(bin, "calls");
			const out = join(bin, "out");
			const digest = `sha256:${"d".repeat(64)}`;
			writeFileSync(out, "");
			writeFileSync(
				join(bin, "timeout"),
				[
					"#!/bin/sh",
					`echo "timeout $*" >> "${calls}"`,
					'seconds="$1"; shift; "$@"',
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			writeFileSync(
				join(bin, "docker"),
				[
					"#!/bin/sh",
					'if [ "$1" = login ]; then cat > /dev/null; exit 0; fi',
					'if [ "$1 $2 $3" = "manifest inspect -v" ]; then',
					manifest
						? `  printf '%s\\n' '[{"Descriptor":{"digest":"${digest}"}}]'`
						: "  exit 1",
					"  exit 0",
					"fi",
					"exit 1",
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			const result = spawnSync(
				process.execPath,
				[
					"--no-warnings",
					"scripts/ci/ensure-ci-worker-image.mts",
					"--resolve-digest",
				],
				{
					cwd: join(import.meta.dirname, "..", ".."),
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH ?? ""}`,
						GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
						GITHUB_TOKEN: "token-for-test",
						GITHUB_OUTPUT: out,
					},
				},
			);
			return {
				result,
				output: readFileSync(out, "utf8"),
				calls: readFileSync(calls, "utf8"),
				digest,
			};
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	}

	it("resolves once with a 60-second bound and exports the immutable ref", () => {
		const resolved = resolveDigestWithStub(true);
		assert.equal(resolved.result.status, 0, resolved.result.stderr);
		const ref = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@${resolved.digest}`;
		assert.match(resolved.result.stdout, new RegExp(ref, "u"));
		assert.match(
			resolved.output,
			new RegExp(`^image_ref=${ref}\\nversion=v[0-9a-f]+\\n$`, "u"),
		);
		assert.match(
			resolved.calls,
			/^timeout 60 docker manifest inspect -v ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:v[0-9a-f]+$/mu,
		);
	});

	it("fails clearly when the release toolchain manifest is absent", () => {
		const resolved = resolveDigestWithStub(false);
		assert.notEqual(resolved.result.status, 0);
		assert.match(resolved.result.stderr, /GHCR manifest absent or unreadable/u);
		assert.equal(resolved.output, "");
	});

	it("detects release ensure path from HOBO_RELEASE_VERSION", () => {
		const prev = {
			ver: process.env.HOBO_RELEASE_VERSION,
			ref: process.env.GITHUB_REF,
		};
		delete process.env.GITHUB_REF;
		process.env.HOBO_RELEASE_VERSION = "0.0.0-alpha.94";
		assert.equal(releaseWorkerEnsurePath(), true);
		delete process.env.HOBO_RELEASE_VERSION;
		process.env.GITHUB_REF = "refs/tags/v0.0.0-alpha.94";
		assert.equal(releaseWorkerEnsurePath(), true);
		process.env.HOBO_RELEASE_VERSION = prev.ver;
		process.env.GITHUB_REF = prev.ref;
	});

	it("exposes materialize-only without throwing on missing image", () => {
		const bin = mkdtempSync(join(tmpdir(), "hobo-ensure-worker-missing-"));
		writeFileSync(
			join(bin, "docker"),
			[
				"#!/bin/sh",
				'if [ "$1 $2" = "image inspect" ]; then exit 1; fi',
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const prev = {
			path: process.env.PATH,
			skip: process.env.HOBO_CI_SKIP_GHCR_PULL,
		};
		try {
			process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
			process.env.HOBO_CI_SKIP_GHCR_PULL = "1";
			assert.equal(materializeCiWorkerImageOnly(), null);
		} finally {
			process.env.PATH = prev.path;
			if (prev.skip === undefined) delete process.env.HOBO_CI_SKIP_GHCR_PULL;
			else process.env.HOBO_CI_SKIP_GHCR_PULL = prev.skip;
			rmSync(bin, { recursive: true, force: true });
		}
	});

	for (const digestRef of [
		undefined,
		`ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"c".repeat(64)}`,
	] as const) {
		it(
			digestRef
				? "pulls the supplied immutable digest and applies both local tags"
				: "pulls the worker tag from GHCR when the registry has it",
			() => {
				const bin = mkdtempSync(join(tmpdir(), "hobo-ensure-worker-"));
				const calls = join(bin, "calls");
				const recordingDockerStubWithMissingLocalImageAndSuccessfulPull = [
					"#!/bin/sh",
					`echo "docker $*" >> "${calls}"`,
					'if [ "$1 $2" = "image inspect" ]; then exit 1; fi',
					'if [ "$1" = login ]; then cat > /dev/null; fi',
					"",
				].join("\n");
				writeFileSync(
					join(bin, "docker"),
					recordingDockerStubWithMissingLocalImageAndSuccessfulPull,
					{ mode: 0o755 },
				);
				const keys = [
					"PATH",
					"GITHUB_REPOSITORY",
					"GITHUB_TOKEN",
					"GITHUB_EVENT_NAME",
					"HOBO_CI_SKIP_GHCR_PULL",
					"HOBO_CI_WORKER_IMAGE_REF",
				] as const;
				const prev = Object.fromEntries(
					keys.map((key) => [key, process.env[key]]),
				);
				try {
					process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
					process.env.GITHUB_REPOSITORY = "Hobo-Labs/HoBo";
					process.env.GITHUB_TOKEN = "token-for-test";
					process.env.GITHUB_EVENT_NAME = "push";
					delete process.env.HOBO_CI_SKIP_GHCR_PULL;
					if (digestRef) process.env.HOBO_CI_WORKER_IMAGE_REF = digestRef;
					else delete process.env.HOBO_CI_WORKER_IMAGE_REF;
					const image = materializeCiWorkerImageOnly();
					const recorded = readFileSync(calls, "utf8");
					assert.match(image ?? "", /^hobo-ci-worker:v/u);
					if (digestRef) {
						assert.ok(
							recorded.includes(`docker manifest inspect ${digestRef}\n`),
						);
						assert.ok(recorded.includes(`docker pull ${digestRef}\n`));
						assert.ok(recorded.includes(`docker tag ${digestRef} ${image}\n`));
						assert.ok(
							recorded.includes(
								`docker tag ${digestRef} hobo-ci-worker:local\n`,
							),
						);
					} else {
						assert.match(
							recorded,
							/^docker manifest inspect ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:v\S+$/mu,
						);
						assert.match(
							recorded,
							/^docker pull ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:v/mu,
						);
						assert.match(recorded, /^docker tag \S+ hobo-ci-worker:local$/mu);
					}
				} finally {
					for (const key of keys) {
						const value = prev[key];
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
					rmSync(bin, { recursive: true, force: true });
				}
			},
		);
	}

	function materializeWithStub(imageRef: string | undefined) {
		const bin = mkdtempSync(join(tmpdir(), "hobo-ensure-worker-invalid-"));
		const calls = join(bin, "calls");
		writeFileSync(
			join(bin, "docker"),
			[
				"#!/bin/sh",
				`echo "docker $*" >> "${calls}"`,
				'if [ "$1 $2" = "image inspect" ]; then exit 1; fi',
				'if [ "$1" = login ]; then cat > /dev/null; fi',
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const keys = [
			"PATH",
			"GITHUB_REPOSITORY",
			"GITHUB_TOKEN",
			"GITHUB_EVENT_NAME",
			"HOBO_CI_SKIP_GHCR_PULL",
			"HOBO_CI_WORKER_IMAGE_REF",
		] as const;
		const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		try {
			process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
			process.env.GITHUB_REPOSITORY = "Hobo-Labs/HoBo";
			process.env.GITHUB_TOKEN = "token-for-test";
			process.env.GITHUB_EVENT_NAME = "push";
			delete process.env.HOBO_CI_SKIP_GHCR_PULL;
			if (imageRef === undefined) delete process.env.HOBO_CI_WORKER_IMAGE_REF;
			else process.env.HOBO_CI_WORKER_IMAGE_REF = imageRef;
			let thrown: Error | undefined;
			try {
				materializeCiWorkerImageOnly();
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				thrown = error;
			}
			return { error: thrown, recorded: readFileSync(calls, "utf8") };
		} finally {
			for (const key of keys) {
				const value = prev[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(bin, { recursive: true, force: true });
		}
	}

	it("never pulls, tags, or falls back when a supplied ref is invalid", () => {
		const digest = `sha256:${"e".repeat(64)}`;
		const invalid = [
			"",
			"   ",
			`ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"e".repeat(63)}`,
			`ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"E".repeat(64)}`,
			"ghcr.io/hobo-labs/hobo/hobo-ci-worker:vdeadbeef",
			`ghcr.io/other/repo/hobo-ci-worker@${digest}`,
			`ghcr.io/hobo-labs/hobo/other-image@${digest}`,
		];
		for (const value of invalid) {
			const { error, recorded } = materializeWithStub(value);
			assert.ok(error, `expected ${JSON.stringify(value)} to throw`);
			assert.match(error?.message ?? "", /HOBO_CI_WORKER_IMAGE_REF/u);
			assert.doesNotMatch(recorded, /docker (?:pull|tag) /u);
			assert.doesNotMatch(
				recorded,
				/docker manifest inspect ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:v/u,
			);
		}
	});

	function publishedStatus(stub: { host: boolean; manifest: boolean }) {
		const bin = mkdtempSync(join(tmpdir(), "hobo-worker-status-"));
		try {
			writeFileSync(
				join(bin, "docker"),
				[
					"#!/bin/sh",
					`if [ "$1 $2" = "image inspect" ]; then exit ${stub.host ? 0 : 1}; fi`,
					'if [ "$1" = login ]; then cat > /dev/null; exit 0; fi',
					`if [ "$1 $2" = "manifest inspect" ]; then exit ${stub.manifest ? 0 : 1}; fi`,
					"exit 0",
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			const out = join(bin, "out");
			writeFileSync(out, "");
			const run = spawnSync(
				process.execPath,
				[
					"--no-warnings",
					"scripts/ci/ensure-ci-worker-image.mts",
					"--published-status",
				],
				{
					cwd: join(import.meta.dirname, "..", ".."),
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH ?? ""}`,
						GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
						GITHUB_TOKEN: "token-for-test",
						GITHUB_OUTPUT: out,
					},
				},
			);
			assert.equal(run.status, 0, run.stderr);
			return readFileSync(out, "utf8");
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	}

	it("needs nothing when the box and GHCR both have this tree's image", () => {
		assert.match(
			publishedStatus({ host: true, manifest: true }),
			/^version=v[0-9a-f]+\nneeded=false\nghcr=true\n$/u,
		);
	});

	it("reports an image the box has but GHCR lacks as unpublished", () => {
		assert.match(
			publishedStatus({ host: true, manifest: false }),
			/^version=v[0-9a-f]+\nneeded=true\nghcr=false\n$/u,
		);
	});

	it("reports an image only GHCR has as published", () => {
		assert.match(
			publishedStatus({ host: false, manifest: true }),
			/^version=v[0-9a-f]+\nneeded=true\nghcr=true\n$/u,
		);
	});

	it("does not treat ordinary CI as release worker ensure", () => {
		const prev = {
			ver: process.env.HOBO_RELEASE_VERSION,
			ref: process.env.GITHUB_REF,
		};
		delete process.env.HOBO_RELEASE_VERSION;
		process.env.GITHUB_REF = "refs/heads/main";
		assert.equal(releaseWorkerEnsurePath(), false);
		process.env.HOBO_RELEASE_VERSION = prev.ver;
		process.env.GITHUB_REF = prev.ref;
	});
});
