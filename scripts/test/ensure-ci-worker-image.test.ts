import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	ciWorkerImagePublished,
	DEFAULT_WORKER_PULL_BUDGET_SEC,
	ensureCiWorkerImage,
	ghcrWorkerPullable,
	materializeCiWorkerImageOnly,
	materializeCiWorkerImageResult,
	pullRequestWorkerTag,
	pullWorkerFromGhcr,
	releaseWorkerEnsurePath,
	remoteWorkerTag,
	resolveWorkerRemoteRef,
	selectWorkerRepoDigest,
	validatedWorkerDigestRef,
	workerPullBudgetSec,
} from "../ci/ensure-ci-worker-image.mts";

describe("ensure-ci-worker-image", () => {
	const workerDigest = `sha256:${"a".repeat(64)}`;
	const workerRepoRef = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@${workerDigest}`;

	it("selects the matching worker RepoDigests entry and rejects foreign digests", () => {
		assert.equal(
			selectWorkerRepoDigest("Hobo-Labs/HoBo", [
				"ghcr.io/other/repo/worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				workerRepoRef,
			]),
			workerRepoRef,
		);
		assert.throws(
			() =>
				selectWorkerRepoDigest("Hobo-Labs/HoBo", [
					"ghcr.io/other/repo/worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				]),
			/no matching RepoDigests entry/u,
		);
		assert.throws(
			() =>
				selectWorkerRepoDigest("Hobo-Labs/HoBo", [
					workerRepoRef,
					`ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"b".repeat(64)}`,
				]),
			/ambiguous/u,
		);
	});

	it("tags GHCR worker refs lower-case", () => {
		assert.equal(
			remoteWorkerTag("Hobo-Labs/HoBo", "vdeadbeefcafe"),
			"ghcr.io/hobo-labs/hobo/hobo-ci-worker:vdeadbeefcafe",
		);
	});

	it("names a pull request's worker by its number and content key", () => {
		assert.equal(
			pullRequestWorkerTag("Hobo-Labs/HoBo", 2953, "v749d8677addb"),
			"ghcr.io/hobo-labs/hobo/hobo-ci-worker:pr-2953-v749d8677addb",
		);
	});

	it("parses one positive pull budget and falls back on junk", () => {
		const prev = process.env.HOBO_CI_WORKER_PULL_BUDGET_SEC;
		delete process.env.HOBO_CI_WORKER_PULL_BUDGET_SEC;
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
		if (prev === undefined) delete process.env.HOBO_CI_WORKER_PULL_BUDGET_SEC;
		else process.env.HOBO_CI_WORKER_PULL_BUDGET_SEC = prev;
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

	function resolveDigestWithStub(
		manifest: boolean,
		login = true,
		budgetSec = 5,
	) {
		const bin = mkdtempSync(join(tmpdir(), "hobo-worker-resolve-"));
		try {
			const calls = join(bin, "calls");
			const out = join(bin, "out");
			const digest = `sha256:${"d".repeat(64)}`;
			writeFileSync(out, "");
			writeFileSync(calls, "");
			writeFileSync(
				join(bin, "timeout"),
				[
					"#!/bin/sh",
					`echo "timeout $*" >> "${calls}"`,
					"shift",
					'exec "$@"',
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			writeFileSync(
				join(bin, "sleep"),
				["#!/bin/sh", "exit 0", ""].join("\n"),
				{ mode: 0o755 },
			);
			writeFileSync(
				join(bin, "docker"),
				[
					"#!/bin/sh",
					`if [ "$1" = login ]; then cat > /dev/null; exit ${login ? 0 : 1}; fi`,
					'if [ "$1" = pull ]; then',
					manifest ? "  exit 0" : "  exit 1",
					"fi",
					'if [ "$1 $2" = "manifest inspect" ]; then',
					manifest ? "  exit 0" : "  exit 1",
					"fi",
					'if [ "$1 $2" = "image inspect" ]; then',
					manifest
						? [
								`  printf '%s\\n' '["ghcr.io/hobo-labs/hobo/hobo-ci-worker@${digest}"]'`,
								"  exit 0",
							].join("\n")
						: "  exit 1",
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
						PATH: `${bin}:/usr/bin:/bin`,
						GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
						GITHUB_TOKEN: "token-for-test",
						GITHUB_OUTPUT: out,
						HOBO_CI_WORKER_PULL_BUDGET_SEC: String(budgetSec),
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
	});

	it("lets a slow release image pull use the remaining shared deadline", () => {
		const resolved = resolveDigestWithStub(true, true, 300);
		assert.equal(resolved.result.status, 0, resolved.result.stderr);
		const match = resolved.calls.match(
			/timeout (\d+) docker pull ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:v/u,
		);
		assert.ok(match);
		assert.ok(Number(match[1]) > 120 && Number(match[1]) <= 300);
	});

	it("fails clearly when the release toolchain manifest is absent", () => {
		const resolved = resolveDigestWithStub(false);
		assert.notEqual(resolved.result.status, 0);
		assert.match(
			resolved.result.stderr,
			/timed out after 5s waiting for pullable worker image|GHCR manifest absent or unreadable/u,
		);
		assert.equal(resolved.output, "");
	});

	it("reports a failed registry login while resolving a release digest", () => {
		const resolved = resolveDigestWithStub(true, false);
		assert.notEqual(resolved.result.status, 0);
		assert.match(
			resolved.result.stderr,
			/GHCR login failed while resolving the worker digest/u,
		);
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
		// A stub Docker CLI with nothing local: a self-hosted runner shares the
		// host's Docker, which may already hold this tree's worker image.
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
		writeFileSync(calls, "");
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

	function materializeForPullRequest(headRepository: string) {
		const bin = mkdtempSync(join(tmpdir(), "hobo-ensure-worker-pr-"));
		const calls = join(bin, "calls");
		const event = join(bin, "event.json");
		writeFileSync(
			event,
			JSON.stringify({
				pull_request: {
					number: 2953,
					head: { repo: { full_name: headRepository } },
					base: { repo: { full_name: "Hobo-Labs/HoBo" } },
				},
			}),
		);
		writeFileSync(
			join(bin, "docker"),
			[
				"#!/bin/sh",
				`echo "docker $*" >> "${calls}"`,
				'if [ "$1 $2" = "image inspect" ]; then exit 1; fi',
				'if [ "$1" = login ]; then cat > /dev/null; exit 0; fi',
				'if [ "$1 $2" = "manifest inspect" ]; then case "$3" in *:pr-2953-v*) exit 0 ;; *) exit 1 ;; esac; fi',
				'if [ "$1" = pull ]; then case "$2" in *:pr-2953-v*) exit 0 ;; *) exit 1 ;; esac; fi',
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const keys = [
			"PATH",
			"GITHUB_REPOSITORY",
			"GITHUB_TOKEN",
			"GITHUB_EVENT_NAME",
			"GITHUB_EVENT_PATH",
			"HOBO_CI_SKIP_GHCR_PULL",
			"HOBO_CI_WORKER_IMAGE_REF",
		] as const;
		const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		try {
			process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
			process.env.GITHUB_REPOSITORY = "Hobo-Labs/HoBo";
			process.env.GITHUB_TOKEN = "token-for-test";
			process.env.GITHUB_EVENT_NAME = "pull_request";
			process.env.GITHUB_EVENT_PATH = event;
			delete process.env.HOBO_CI_SKIP_GHCR_PULL;
			delete process.env.HOBO_CI_WORKER_IMAGE_REF;
			const image = materializeCiWorkerImageOnly();
			return {
				image,
				recorded: existsSync(calls) ? readFileSync(calls, "utf8") : "",
			};
		} finally {
			for (const key of keys) {
				const value = prev[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(bin, { recursive: true, force: true });
		}
	}

	it("pulls the image this pull request's image job shared when GHCR has no main build of the key", () => {
		const { image, recorded } = materializeForPullRequest("Hobo-Labs/HoBo");
		assert.match(image ?? "", /^hobo-ci-worker:v[0-9a-f]{12}$/u);
		assert.match(
			recorded,
			/^docker manifest inspect ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:v[0-9a-f]{12}$/mu,
		);
		assert.match(
			recorded,
			/^docker pull ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:pr-2953-v[0-9a-f]{12}$/mu,
		);
		assert.match(
			recorded,
			/^docker tag ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:pr-2953-v\S+ hobo-ci-worker:local$/mu,
		);
	});

	it("never pulls another repository's pull request image for a fork", () => {
		const { image, recorded } = materializeForPullRequest("someone/HoBo");
		assert.equal(image, null);
		assert.doesNotMatch(recorded, /pr-2953-/u);
	});

	// The post-green publisher asks what GHCR has for this tree (finding 113).
	function withWorkerPublishStub(
		stub: {
			host: boolean;
			manifest: boolean;
			pull?: boolean;
			unreadable?: boolean;
		},
		run: () => void,
	) {
		const pullOk = stub.pull ?? stub.manifest;
		const bin = mkdtempSync(join(tmpdir(), "hobo-worker-status-"));
		const prev = {
			PATH: process.env.PATH,
			GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
			GITHUB_ACTOR: process.env.GITHUB_ACTOR,
			GITHUB_TOKEN: process.env.GITHUB_TOKEN,
		};
		try {
			writeFileSync(
				join(bin, "timeout"),
				["#!/bin/sh", "shift", 'exec "$@"', ""].join("\n"),
				{ mode: 0o755 },
			);
			writeFileSync(
				join(bin, "docker"),
				[
					"#!/bin/sh",
					`if [ "$1 $2" = "image inspect" ]; then exit ${stub.host ? 0 : 1}; fi`,
					'if [ "$1" = "login" ]; then cat > /dev/null; exit 0; fi',
					`if [ "$1 $2" = "manifest inspect" ]; then ${stub.manifest ? "exit 0" : `echo '${stub.unreadable ? "registry unavailable" : "no such manifest: worker"}' >&2; exit 1`}; fi`,
					`if [ "$1" = "pull" ]; then exit ${pullOk ? 0 : 1}; fi`,
					"exit 0",
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			process.env.PATH = `${bin}:${prev.PATH ?? ""}`;
			process.env.GITHUB_REPOSITORY = "Hobo-Labs/HoBo";
			process.env.GITHUB_ACTOR = "github-actions";
			process.env.GITHUB_TOKEN = "token-for-test";
			run();
		} finally {
			for (const [key, value] of Object.entries(prev)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(bin, { recursive: true, force: true });
		}
	}

	function publishedStatus(
		stub: {
			host: boolean;
			manifest: boolean;
			pull?: boolean;
			login?: boolean;
			unreadable?: boolean;
		},
		expectInconclusive?:
			| "pull-failed"
			| "login-failed"
			| "manifest-unavailable",
	) {
		const pullOk = stub.pull ?? stub.manifest;
		const bin = mkdtempSync(join(tmpdir(), "hobo-worker-status-cli-"));
		try {
			writeFileSync(
				join(bin, "timeout"),
				["#!/bin/sh", "shift", 'exec "$@"', ""].join("\n"),
				{ mode: 0o755 },
			);
			writeFileSync(
				join(bin, "docker"),
				[
					"#!/bin/sh",
					`if [ "$1 $2" = "image inspect" ]; then exit ${stub.host ? 0 : 1}; fi`,
					`if [ "$1" = "login" ]; then cat > /dev/null; exit ${stub.login === false ? 1 : 0}; fi`,
					`if [ "$1 $2" = "manifest inspect" ]; then ${stub.manifest ? "exit 0" : `echo '${stub.unreadable ? "registry unavailable" : "no such manifest: worker"}' >&2; exit 1`}; fi`,
					`if [ "$1" = "pull" ]; then exit ${pullOk ? 0 : 1}; fi`,
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
			if (expectInconclusive) {
				assert.notEqual(run.status, 0);
				assert.ok(
					run.stderr.includes(
						`publication check inconclusive (${expectInconclusive}); refusing to rebuild`,
					),
				);
			} else {
				assert.equal(run.status, 0, run.stderr);
			}
			return readFileSync(out, "utf8");
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	}

	it("needs nothing when the box and GHCR both have this tree's image", () => {
		withWorkerPublishStub({ host: true, manifest: true, pull: true }, () => {
			const status = ciWorkerImagePublished();
			assert.equal(status.host, true);
			assert.equal(status.ghcr, true);
			assert.equal(status.host && status.ghcr, true);
		});
		assert.match(
			publishedStatus({ host: true, manifest: true, pull: true }),
			/^version=v[0-9a-f]+\nneeded=false\nghcr=true\n$/u,
		);
	});

	it("reports an image the box has but GHCR lacks as unpublished", () => {
		withWorkerPublishStub({ host: true, manifest: false }, () => {
			const status = ciWorkerImagePublished();
			assert.equal(status.ghcr, false);
		});
		assert.match(
			publishedStatus({ host: true, manifest: false }),
			/^version=v[0-9a-f]+\nneeded=true\nghcr=false\n$/u,
		);
	});

	it("reports an image only GHCR has as published", () => {
		withWorkerPublishStub({ host: false, manifest: true, pull: true }, () => {
			assert.equal(
				ghcrWorkerPullable(
					"Hobo-Labs/HoBo",
					ciWorkerImagePublished().version,
					"token-for-test",
				),
				true,
			);
			const status = ciWorkerImagePublished();
			assert.equal(status.host, false);
			assert.equal(status.ghcr, true);
		});
		assert.match(
			publishedStatus({ host: false, manifest: true, pull: true }),
			/^version=v[0-9a-f]+\nneeded=true\nghcr=true\n$/u,
		);
	});

	it("recognizes a pullable image when the manifest probe is unreadable", () => {
		withWorkerPublishStub(
			{ host: false, manifest: false, pull: true, unreadable: true },
			() => {
				const status = ciWorkerImagePublished();
				assert.equal(status.ghcr, true);
			},
		);
		assert.match(
			publishedStatus({
				host: false,
				manifest: false,
				pull: true,
				unreadable: true,
			}),
			/^version=v[0-9a-f]+\nneeded=true\nghcr=true\n$/u,
		);
	});

	it("refuses to infer a missing image from an incomplete pull", () => {
		withWorkerPublishStub({ host: false, manifest: true, pull: false }, () => {
			const status = ciWorkerImagePublished();
			assert.equal(status.ghcr, false);
			assert.equal(status.ghcrProbe, "pull-failed");
		});
		assert.equal(
			publishedStatus(
				{ host: false, manifest: true, pull: false },
				"pull-failed",
			),
			"",
		);
	});

	it("does not rebuild when the publication probe cannot authenticate", () => {
		assert.equal(
			publishedStatus(
				{ host: false, manifest: false, login: false },
				"login-failed",
			),
			"",
		);
	});

	it("does not rebuild when both manifest and pull probes are inconclusive", () => {
		assert.equal(
			publishedStatus(
				{ host: false, manifest: false, pull: false, unreadable: true },
				"manifest-unavailable",
			),
			"",
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

	function withReleaseProbe(
		mode:
			| "pull_failed"
			| "manifest_absent"
			| "manifest_unreadable"
			| "login_failed"
			| "local_digest"
			| "remote_digest",
		digestRef: string | undefined,
		run: (calls: string) => void,
		candidatePresent = false,
	) {
		const bin = mkdtempSync(join(tmpdir(), "hobo-ensure-worker-release-"));
		const calls = join(bin, "calls");
		writeFileSync(calls, "");
		writeFileSync(
			join(bin, "timeout"),
			[
				"#!/bin/sh",
				`echo "timeout $*" >> "${calls}"`,
				'case " $* " in *build.sh*) exit 99 ;; esac',
				"shift",
				'exec "$@"',
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(join(bin, "sleep"), ["#!/bin/sh", "exit 0", ""].join("\n"), {
			mode: 0o755,
		});
		const manifestStatus =
			mode === "manifest_absent" || mode === "manifest_unreadable" ? 1 : 0;
		const pullStatus =
			mode === "pull_failed" || mode === "manifest_absent" ? 1 : 0;
		writeFileSync(
			join(bin, "docker"),
			[
				"#!/bin/sh",
				`echo "docker $*" >> "${calls}"`,
				`if [ "$1" = login ]; then cat >/dev/null; exit ${mode === "login_failed" ? 1 : 0}; fi`,
				'if [ "$1 $2" = "image inspect" ]; then',
				candidatePresent
					? '  case "$3" in hobo-ci-worker:v*) exit 0 ;; esac'
					: "",
				digestRef && mode !== "remote_digest"
					? `  if [ "$3" = "${digestRef}" ]; then exit 0; fi`
					: "  exit 1",
				"  exit 1",
				"fi",
				`if [ "$1 $2" = "manifest inspect" ]; then exit ${manifestStatus}; fi`,
				`if [ "$1" = pull ]; then exit ${pullStatus}; fi`,
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const keys = [
			"PATH",
			"GITHUB_REPOSITORY",
			"GITHUB_TOKEN",
			"GITHUB_EVENT_NAME",
			"GITHUB_REF",
			"HOBO_RELEASE_VERSION",
			"HOBO_CI_SKIP_GHCR_PULL",
			"HOBO_CI_WORKER_IMAGE_REF",
			"HOBO_CI_WORKER_PULL_BUDGET_SEC",
		] as const;
		const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		try {
			process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
			process.env.GITHUB_REPOSITORY = "Hobo-Labs/HoBo";
			process.env.GITHUB_TOKEN = "token-for-test";
			process.env.GITHUB_EVENT_NAME = "push";
			delete process.env.GITHUB_REF;
			delete process.env.HOBO_CI_SKIP_GHCR_PULL;
			process.env.HOBO_CI_WORKER_PULL_BUDGET_SEC = "7";
			if (mode === "local_digest" || mode === "remote_digest") {
				process.env.HOBO_RELEASE_VERSION = "0.0.0-alpha.94";
				if (digestRef) process.env.HOBO_CI_WORKER_IMAGE_REF = digestRef;
			} else {
				process.env.HOBO_RELEASE_VERSION = "0.0.0-alpha.94";
				delete process.env.HOBO_CI_WORKER_IMAGE_REF;
			}
			run(calls);
		} finally {
			for (const key of keys) {
				const value = prev[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(bin, { recursive: true, force: true });
		}
	}

	it("distinguishes a failed pull after a readable or unreadable manifest", () => {
		withReleaseProbe("pull_failed", undefined, (calls) => {
			const materialized = materializeCiWorkerImageResult();
			assert.equal(materialized.ok, false);
			if (materialized.ok || materialized.failure?.kind !== "pull_failed") {
				assert.fail(
					`expected pull_failed, got ${JSON.stringify(materialized)}`,
				);
			}
			assert.equal(materialized.failure.budgetSec, 7);
			assert.match(
				materialized.failure.remote,
				/^ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:v[0-9a-f]{12}$/u,
			);
			let thrown: Error | undefined;
			try {
				ensureCiWorkerImage();
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				thrown = error;
			}
			assert.ok(thrown, "release pull_failed must throw");
			assert.match(thrown.message, /manifest present/u);
			assert.match(thrown.message, /budgetSec=7/u);
			assert.doesNotMatch(thrown.message, /manifest absent/u);
			const recorded = readFileSync(calls, "utf8");
			assert.match(recorded, /docker pull /u);
			assert.doesNotMatch(recorded, /build\.sh/u);
		});

		withReleaseProbe("manifest_absent", undefined, (calls) => {
			const materialized = materializeCiWorkerImageResult();
			assert.equal(materialized.ok, false);
			if (
				materialized.ok ||
				materialized.failure?.kind !== "manifest_unavailable"
			) {
				assert.fail(
					`expected manifest_unavailable, got ${JSON.stringify(materialized)}`,
				);
			}
			assert.equal(materialized.failure.budgetSec, 7);
			let thrown: Error | undefined;
			try {
				ensureCiWorkerImage();
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				thrown = error;
			}
			assert.ok(thrown, "release manifest_absent must throw");
			assert.match(thrown.message, /GHCR manifest absent or unreadable/u);
			assert.doesNotMatch(thrown.message, /manifest present/u);
			assert.match(thrown.message, /budgetSec=7/u);
			const recorded = readFileSync(calls, "utf8");
			assert.match(recorded, /docker pull /u);
			assert.doesNotMatch(recorded, /build\.sh/u);
		});
	});

	it("reuses a local digest from HOBO_CI_WORKER_IMAGE_REF without pulling", () => {
		const digestRef = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"d".repeat(64)}`;
		withReleaseProbe("local_digest", digestRef, (calls) => {
			const materialized = materializeCiWorkerImageResult();
			assert.equal(materialized.ok, true);
			if (!materialized.ok) return;
			assert.match(materialized.image, /^hobo-ci-worker:v[0-9a-f]{12}$/u);
			assert.equal(ensureCiWorkerImage(), materialized.image);
			const recorded = readFileSync(calls, "utf8");
			assert.ok(
				recorded.includes(`docker tag ${digestRef} ${materialized.image}`),
			);
			assert.ok(
				recorded.includes(`docker tag ${digestRef} hobo-ci-worker:local`),
			);
			assert.doesNotMatch(recorded, /docker pull /u);
			assert.doesNotMatch(recorded, /manifest inspect/u);
			assert.doesNotMatch(recorded, /build\.sh/u);
		});
	});

	it("uses the supplied digest instead of a cached version tag", () => {
		const digestRef = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"d".repeat(64)}`;
		for (const mode of ["local_digest", "remote_digest"] as const) {
			withReleaseProbe(
				mode,
				digestRef,
				(calls) => {
					const result = materializeCiWorkerImageResult();
					assert.equal(result.ok, true);
					if (!result.ok) return;
					const recorded = readFileSync(calls, "utf8");
					assert.ok(
						recorded.includes(`docker tag ${digestRef} ${result.image}`),
					);
					if (mode === "remote_digest")
						assert.ok(recorded.includes(`docker pull ${digestRef}`));
				},
				true,
			);
		}
	});

	it("rejects an invalid supplied digest even when a version tag is cached", () => {
		withReleaseProbe(
			"local_digest",
			"ghcr.io/other/worker:latest",
			(calls) => {
				assert.throws(
					() => materializeCiWorkerImageResult(),
					/HOBO_CI_WORKER_IMAGE_REF/u,
				);
				assert.doesNotMatch(readFileSync(calls, "utf8"), /docker tag /u);
			},
			true,
		);
	});

	it("does not build or use a cached tag when a supplied digest is unavailable", () => {
		const digestRef = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"d".repeat(64)}`;
		withReleaseProbe(
			"remote_digest",
			digestRef,
			(calls) => {
				delete process.env.HOBO_RELEASE_VERSION;
				process.env.HOBO_CI_SKIP_GHCR_PULL = "1";
				assert.throws(() => ensureCiWorkerImage(), /supplied worker digest/u);
				assert.doesNotMatch(
					readFileSync(calls, "utf8"),
					/docker tag |build\.sh/u,
				);
			},
			true,
		);
	});

	it("attempts the pull when the manifest probe is unreadable", () => {
		withReleaseProbe("manifest_unreadable", undefined, (calls) => {
			const result = materializeCiWorkerImageResult();
			assert.equal(result.ok, true);
			assert.match(readFileSync(calls, "utf8"), /docker pull /u);
		});
	});

	it("reports a login failure without claiming the manifest is absent", () => {
		withReleaseProbe("login_failed", undefined, (calls) => {
			const result = materializeCiWorkerImageResult();
			assert.equal(result.ok, false);
			if (result.ok) return;
			assert.equal(result.failure?.kind, "login_failed");
			assert.doesNotMatch(
				readFileSync(calls, "utf8"),
				/docker (?:manifest inspect|pull) /u,
			);
		});
	});
});
