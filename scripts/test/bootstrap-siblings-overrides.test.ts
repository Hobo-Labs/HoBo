/**
 * MIRROR_BIN and HOBO_OPENSESAME_KIT point a lane at a local binary instead of
 * the pinned, hash-checked release. Such a binary is unverified by definition:
 * nothing here (or anywhere) has looked at it. That is fine on a developer's
 * machine and wrong in CI, where a green run must mean the pinned bytes ran.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	runBootstrapAsync,
	scratch,
	sha256Hex,
	writeManifest,
} from "./support/pins-support.ts";

const DIGEST = sha256Hex("x");

function manifestRoot(): string {
	const root = scratch("overrides");
	const file = `{"url":"https://example.com/m","sha256":"${DIGEST}","size":1,"entry":"mirror"}`;
	writeManifest(
		root,
		`{"mirror":{"repo":"https://example.com/o/mirror","tag":"v1.0.0","files":{"linux-x64":${file},"linux-arm64":${file}}},"opensesame-kit":null}`,
	);
	return root;
}

describe("an override is unverified, and CI refuses it", () => {
	for (const verb of ["--status", "--fetch"]) {
		it(`${verb} exits 1 in CI when an override is set, naming the variable and the way through`, async () => {
			const root = manifestRoot();
			const run = await runBootstrapAsync(root, [verb], {
				CI: "true",
				MIRROR_BIN: "/opt/local/mirror",
			});
			assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
			assert.match(run.stderr, /OVERRIDE_IN_CI/);
			assert.match(run.stderr, /MIRROR_BIN/);
			assert.match(run.stderr, /unverified/);
			assert.match(run.stderr, /HOBO_PINS_ALLOW_OVERRIDE=1/);
		});
	}

	it("a null pin's override is refused in CI too", async () => {
		const run = await runBootstrapAsync(manifestRoot(), ["--status"], {
			CI: "1",
			HOBO_OPENSESAME_KIT: "/opt/kit",
		});
		assert.equal(run.status, 1);
		assert.match(run.stderr, /HOBO_OPENSESAME_KIT/);
	});

	it("HOBO_PINS_ALLOW_OVERRIDE=1 lets it through, and status still says the binary is unverified", async () => {
		const run = await runBootstrapAsync(
			manifestRoot(),
			["--status", "--offline"],
			{
				CI: "true",
				MIRROR_BIN: "/opt/local/mirror",
				HOBO_PINS_ALLOW_OVERRIDE: "1",
			},
		);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stdout,
			/MIRROR_BIN is set and shadows this pin: that binary is not verified/,
		);
	});

	it("outside CI an override is reported, not refused", async () => {
		const run = await runBootstrapAsync(
			manifestRoot(),
			["--status", "--offline"],
			{
				CI: "",
				MIRROR_BIN: "/opt/local/mirror",
			},
		);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(run.stdout, /MIRROR_BIN is set and shadows this pin/);
	});

	it("CI=false, CI=0 and an empty override are not CI and not an override", async () => {
		for (const ci of ["false", "0", ""]) {
			const run = await runBootstrapAsync(
				manifestRoot(),
				["--status", "--offline"],
				{
					CI: ci,
					MIRROR_BIN: "/opt/local/mirror",
				},
			);
			assert.equal(run.status, 0, `CI=${ci}\n${run.stdout}${run.stderr}`);
		}
		const empty = await runBootstrapAsync(
			manifestRoot(),
			["--status", "--offline"],
			{
				CI: "true",
				MIRROR_BIN: "",
			},
		);
		assert.equal(empty.status, 0, `${empty.stdout}${empty.stderr}`);
		assert.doesNotMatch(empty.stdout, /shadows/);
	});
});
