/**
 * `pins:status` against a pin with a sparse cone (ADR-0169). `pins:fetch`
 * checks out only the cone; status says when the checkout is something else.
 * A full checkout, or a cone wider than the pin's, still has every directory
 * the workspace links (a hosted CI checkout is full), so it is a warning and
 * the exit status stays 0. A directory of the pin's cone that is not checked
 * out is a failure.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	makeReference,
	makeRemote,
	makeWork,
	type Remote,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

interface Fixture {
	readonly remote: Remote;
	readonly work: string;
	readonly reference: string;
	readonly sub: string;
}

/** A work tree whose pin `lib` has the cone `packages/a`, fetched. */
function fetched(): Fixture {
	const dir = scratch("sparse-status");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, 1, { sparse: ["packages/a"] });
	const reference = makeReference(dir, remote);
	ok(runBootstrap(work, ["--reference", reference]));
	return { remote, work, reference, sub: join(work, "external/lib") };
}

function ok(run: { status: number | null; stdout: string; stderr: string }) {
	assert.equal(
		run.status,
		0,
		`exit ${run.status}\n${run.stdout}\n${run.stderr}`,
	);
	return run;
}

const okLine = (f: Fixture) =>
	`lib  ${(f.remote.shas[1] ?? "").slice(0, 7)}  ok`;

describe("pins:status and the sparse cone", () => {
	it("a checkout of exactly the pin's cone is ok with no warning", () => {
		const f = fetched();
		const run = ok(runBootstrap(f.work, ["--status", "--offline"]));
		assert.ok(run.stdout.split("\n").includes(okLine(f)), run.stdout);
		assert.doesNotMatch(run.stdout, /warning/);
	});

	it("a full checkout is ok with a warning naming the cone and pins:fetch, which restores it", () => {
		const f = fetched();
		git(f.sub, ["sparse-checkout", "disable"]);
		const run = ok(runBootstrap(f.work, ["--status", "--offline"]));
		assert.ok(run.stdout.split("\n").includes(okLine(f)), run.stdout);
		assert.match(
			run.stdout,
			/ {2}warning: external\/lib is checked out in full, not as the pin's sparse cone \(packages\/a\)\n {2}fix: pnpm run pins:fetch lib {3}\(checks out the pin's sparse cone: packages\/a\)/,
		);

		ok(runBootstrap(f.work, ["--fetch", "lib", "--reference", f.reference]));
		assert.doesNotMatch(
			ok(runBootstrap(f.work, ["--status", "--offline"])).stdout,
			/warning/,
		);
	});

	it("a wider cone that still has every pinned directory is ok with a warning", () => {
		const f = fetched();
		git(f.sub, [
			"sparse-checkout",
			"set",
			"--cone",
			"packages/a",
			"packages/b",
		]);
		const run = ok(runBootstrap(f.work, ["--status", "--offline"]));
		assert.match(
			run.stdout,
			/warning: external\/lib is a sparse checkout of packages\/a packages\/b, not the pin's cone \(packages\/a\)/,
		);
	});

	it("a cone directory the pinned commit does not have fails, naming the pin's cone and the bump as the fix", () => {
		const dir = scratch("sparse-status-absent");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1, {
			sparse: ["packages/a", "packages/gone"],
		});
		ok(runBootstrap(work, ["--reference", makeReference(dir, remote)]));
		const run = runBootstrap(work, ["--status", "--offline"]);
		assert.equal(run.status, 1, run.stdout);
		assert.match(
			run.stdout,
			/ {2}external\/lib does not have packages\/gone, which the pin's sparse cone names, and neither does the pinned commit\n {2}fix: drop packages\/gone from lib's "sparse" list in tools\/pins\/siblings\.json, or move the pin to a commit that has it: pnpm run pins:bump lib <ref>/,
		);
		// Fetching again checks out the same commit, so it is not offered.
		assert.doesNotMatch(run.stdout, /fix: pnpm run pins:fetch lib/);
	});

	it("a cone without a pinned directory fails, with pins:fetch as the fix", () => {
		const f = fetched();
		git(f.sub, ["sparse-checkout", "set", "--cone", "packages/b"]);
		const run = runBootstrap(f.work, ["--status", "--offline"]);
		assert.equal(run.status, 1, run.stdout);
		assert.match(
			run.stdout,
			/lib {2}[0-9a-f]{7} {2}FAIL\n {2}external\/lib does not have packages\/a, which the pin's sparse cone names\n {2}fix: pnpm run pins:fetch lib/,
		);
		assert.match(run.stderr, /1 pin\(s\) out of date/);
	});
});
