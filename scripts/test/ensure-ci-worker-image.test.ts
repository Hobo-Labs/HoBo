import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import {
	materializeCiWorkerImageOnly,
	releaseWorkerEnsurePath,
	remoteWorkerTag,
} from "../ci/ensure-ci-worker-image.mts";

describe("ensure-ci-worker-image", () => {
	it("tags GHCR worker refs lower-case", () => {
		assert.equal(
			remoteWorkerTag("Hobo-Labs/HoBo", "vdeadbeefcafe"),
			"ghcr.io/hobo-labs/hobo/hobo-ci-worker:vdeadbeefcafe",
		);
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
		const prev = process.env.HOBO_CI_SKIP_GHCR_PULL;
		process.env.HOBO_CI_SKIP_GHCR_PULL = "1";
		assert.equal(materializeCiWorkerImageOnly(), null);
		process.env.HOBO_CI_SKIP_GHCR_PULL = prev;
	});

	it("pulls the worker from GHCR when the registry has it", () => {
		// A stub Docker CLI: nothing local, the login and the manifest answer, the
		// pull works. Every call is recorded.
		const bin = mkdtempSync(join(tmpdir(), "hobo-ensure-worker-"));
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
		] as const;
		const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		try {
			process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
			process.env.GITHUB_REPOSITORY = "Hobo-Labs/HoBo";
			process.env.GITHUB_TOKEN = "token-for-test";
			process.env.GITHUB_EVENT_NAME = "push";
			delete process.env.HOBO_CI_SKIP_GHCR_PULL;
			const image = materializeCiWorkerImageOnly();
			const recorded = readFileSync(calls, "utf8");
			assert.match(image ?? "", /^hobo-ci-worker:v/u);
			assert.match(
				recorded,
				/^docker manifest inspect ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:v\S+$/mu,
			);
			assert.match(
				recorded,
				/^docker pull ghcr\.io\/hobo-labs\/hobo\/hobo-ci-worker:v/mu,
			);
			assert.match(recorded, /^docker tag \S+ hobo-ci-worker:local$/mu);
		} finally {
			for (const key of keys) {
				const value = prev[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(bin, { recursive: true, force: true });
		}
	});

	// A main push asks what is published rather than what its commits touched.
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
		assert.equal(
			publishedStatus({ host: true, manifest: true }),
			"needed=false\nghcr=true\n",
		);
	});

	it("publishes an image the box has but GHCR lacks", () => {
		assert.equal(
			publishedStatus({ host: true, manifest: false }),
			"needed=true\nghcr=false\n",
		);
	});

	it("pulls, without republishing, an image only GHCR has", () => {
		assert.equal(
			publishedStatus({ host: false, manifest: true }),
			"needed=true\nghcr=true\n",
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
