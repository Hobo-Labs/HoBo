/**
 * Where the real OpenSesame finds `node` for its env-spec bridge. A newer
 * OpenSesame (efe9c5adb, crates/env-spec/src/node_bridge.rs) searches only
 * PATH directories that group and others cannot write, starts that `node` by
 * its absolute path with a minimal environment, and refuses the run before the
 * command starts when none holds one; an older one ran a bare `node`. Either
 * way the adapter must call it a missing bridge, not a bad schema.
 */

import { mkdirSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { outcomeError } from "../../src/outcome.js";
import { parsed } from "../fixtures/bindings.js";
import { record } from "./evidence.js";
import { type Kit, resolveKit } from "./kit.js";
import { runChild } from "./run-child.js";
import { Sandbox, STORE_PASSPHRASE } from "./sandbox.js";
import { startUpstream, type Upstream } from "./tls.js";

let kit: Kit;
const sandboxes: Sandbox[] = [];
const upstreams: Upstream[] = [];

beforeAll(() => {
	kit = resolveKit(process.env);
});

afterEach(async () => {
	for (const upstream of upstreams.splice(0)) await upstream.close();
	for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

describe("the env-spec bridge's node, under the real opensesame", () => {
	it("a PATH whose trusted directories hold no node is bridge_missing, and the command never starts", async () => {
		const sandbox = Sandbox.create(kit);
		sandboxes.push(sandbox);
		const upstream = await startUpstream(sandbox.pki);
		upstreams.push(upstream);
		sandbox.setUp();
		// A directory the adapter keeps (the user's, 0755, nothing above it writable by others) with no node in it.
		const empty = sandbox.path("bin-without-node");
		mkdirSync(empty, { mode: 0o755 });
		const run = await runChild(
			sandbox,
			{ requests: [] },
			{ bindings: parsed(), env: sandbox.runEnv(upstream, { PATH: empty }) },
		);
		expect(run.outcome).toMatchObject({ kind: "bridge_missing", exitCode: 1 });
		expect(outcomeError(run.outcome)?.code).toBe("bridge_missing");
		expect(run.childEnv).toBeUndefined();
		// The newer binary's words, or the older one's.
		expect(run.stderr).toMatch(/no usable `node`|os error 2/u);
		expect(run.stderr).not.toContain(STORE_PASSPHRASE);
		expect(sandbox.noticeKinds()).toEqual([]);
		record("bridge-no-trusted-node", {
			kind: run.outcome.kind,
			exitCode: run.outcome.exitCode,
			newerWording: run.stderr.includes("no usable `node`"),
			commandStarted: run.childEnv !== undefined,
		});
	});
});
