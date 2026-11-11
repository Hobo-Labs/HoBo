import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
