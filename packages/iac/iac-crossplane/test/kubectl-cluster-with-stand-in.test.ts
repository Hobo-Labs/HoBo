/**
 * The Crossplane claim cluster, driven through a stand-in `kubectl`.
 *
 * Crossplane's model is declarative: HoBo writes a claim into a cluster and the
 * cluster's controllers reconcile it into real infrastructure. This module is
 * the thin boundary between the two, and every property worth pinning is about
 * what it does when the cluster disagrees with what HoBo expected.
 *
 * **A claim that does not exist is `undefined`, not an error.** `getClaim` is
 * how the reconciler asks "is this already there?", and a NotFound is the
 * ordinary answer to that question. Turning it into a throw would make the
 * first deploy of every resource look like a cluster failure.
 *
 * **Any other kubectl failure still throws.** Swallowing everything would turn
 * an unreachable cluster, a permission denial, or a CRD that was never
 * installed into "the claim isn't there yet" — and the reconciler would create
 * a duplicate or spin forever.
 *
 * **Waiting is bounded and reports honestly.** `waitForReady` returns `false`
 * rather than throwing when the claim never reaches Ready, because a claim that
 * is still reconciling is a normal state and the caller decides what to do.
 *
 * **Claim names come back sorted.** A plan whose order depended on the API
 * server's response order would produce a different receipt on every run.
 *
 * The stand-in `kubectl` is a real script on disk, so exit codes and stderr
 * are genuine.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createKubectlCrossplaneCluster,
	KUBECTL_UNAVAILABLE,
} from "../src/kubectl-cluster.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hobo-xp-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A stand-in `kubectl`. `body` decides what each invocation does. */
function fakeKubectl(body: string): string {
	const dir = tempDir("hobo-xp-bin-");
	const bin = join(dir, "kubectl");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const argv = process.argv.slice(2);",
			// `ensureAvailable` probes with `get namespace <ns> -o name`. Answering
			// it here keeps each test's script about the operation under test.
			'if (argv[0] === "get" && argv[1] === "namespace") { process.stdout.write("namespace/default\\n"); process.exit(0); }',
			body,
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	return bin;
}

function cluster(body: string, options: Record<string, unknown> = {}) {
	return createKubectlCrossplaneCluster({
		kubectlBin: fakeKubectl(body),
		// The stand-in is a node script, so its shebang needs node on PATH.
		env: { PATH: dirname(process.execPath) },
		pollIntervalMs: 1,
		...options,
	});
}

/** A cluster document for a claim, ready or not. */
const claimJson = (name: string, ready = true) =>
	JSON.stringify({
		apiVersion: "hobo.dev/v1alpha1",
		kind: "HoboResourceClaim",
		metadata: { name, annotations: {} },
		spec: {},
		// Readiness is a condition, not a phase field: Crossplane reports it the
		// way every Kubernetes controller does.
		status: {
			conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
		},
	});

describe("reaching the cluster", () => {
	it("verifies a reachable cluster", () => {
		expect(() => cluster("process.exit(0);").verifyReachable()).not.toThrow();
	});

	it("refuses an unreachable cluster with a named code", () => {
		const created = cluster(
			'process.stderr.write("connection refused"); process.exit(1);',
		);
		// The lane is optional and cluster-gated. An operator with no cluster
		// needs to be told that, not shown a raw exec failure.
		try {
			created.verifyReachable();
			expect.unreachable("expected the cluster probe to refuse");
		} catch (error) {
			expect((error as { code?: string }).code).toBe(KUBECTL_UNAVAILABLE);
		}
	});

	it("refuses a kubectl binary that is not installed", () => {
		const created = createKubectlCrossplaneCluster({
			kubectlBin: join(tempDir(), "not-installed"),
			env: { PATH: dirname(process.execPath) },
		});
		expect(() => created.verifyReachable()).toThrow();
	});

	it("carries the cluster's own stderr into the refusal", () => {
		const created = cluster(
			'process.stderr.write("Unable to connect to the server"); process.exit(1);',
		);
		// That text is the only thing distinguishing a wrong context from a
		// down cluster from an expired credential.
		expect(() => created.verifyReachable()).toThrow(/Unable to connect/);
	});

	it("passes a context through to kubectl", () => {
		const created = cluster(
			`
			if (!(argv.includes("--context") && argv.includes("prod"))) {
				process.stderr.write("wrong context");
				process.exit(1);
			}
			process.exit(0);
		`,
			{ context: "prod" },
		);
		// Applying a claim to the wrong cluster is the worst outcome this
		// module can produce.
		expect(() => created.verifyReachable()).not.toThrow();
	});
});

describe("reading a claim", () => {
	it("returns a claim the cluster has", () => {
		const created = cluster(`
			if (argv[0] === "get") { process.stdout.write(${JSON.stringify(claimJson("hello"))}); process.exit(0); }
			process.exit(0);
		`);
		expect(created.getClaim("hello")?.name).toBe("hello");
	});

	it("reports a claim that is not yet ready", () => {
		const created = cluster(`
			if (argv[0] === "get") { process.stdout.write(${JSON.stringify(claimJson("hello", false))}); process.exit(0); }
			process.exit(0);
		`);
		// Two vocabularies meet here: the cluster reports a Ready *condition*,
		// and HoBo's claim carries a *phase*. A condition present but "False"
		// has to become "Pending", not "Ready" and not absent.
		expect(created.getClaim("hello")?.status.phase).toBe("Pending");
	});

	it("returns undefined for a claim that is not there", () => {
		const created = cluster(`
			if (argv[0] === "get") {
				process.stderr.write('Error from server (NotFound): hoboresourceclaims "hello" not found');
				process.exit(1);
			}
			process.exit(0);
		`);
		// This is how the reconciler asks "is it already there?". A throw would
		// make the first deploy of every resource look like a cluster failure.
		expect(created.getClaim("hello")).toBeUndefined();
	});

	it("matches a lower-case not-found message too", () => {
		const created = cluster(`
			if (argv[0] === "get") { process.stderr.write("claim not found"); process.exit(1); }
			process.exit(0);
		`);
		expect(created.getClaim("hello")).toBeUndefined();
	});

	it("still throws for any other kubectl failure", () => {
		const created = cluster(`
			if (argv[0] === "get") {
				process.stderr.write('Error from server (Forbidden): access denied');
				process.exit(1);
			}
			process.exit(0);
		`);
		// Swallowing this would turn a permission denial into "not there yet",
		// and the reconciler would create a duplicate or spin forever.
		expect(() => created.getClaim("hello")).toThrow(/Forbidden/);
	});

	it("throws when the CRD was never installed", () => {
		const created = cluster(`
			if (argv[0] === "get") {
				process.stderr.write('error: the server doesn\\'t have a resource type');
				process.exit(1);
			}
			process.exit(0);
		`);
		// A missing CRD means Crossplane is not set up. Reading it as an absent
		// claim would let HoBo write claims nothing will ever reconcile.
		expect(() => created.getClaim("hello")).toThrow();
	});

	it("reads claims from the configured namespace", () => {
		const created = cluster(
			`
			if (argv[0] === "get") {
				if (!(argv.includes("-n") && argv.includes("hobo-system"))) {
					process.stderr.write("wrong namespace");
					process.exit(1);
				}
				process.stdout.write(${JSON.stringify(claimJson("hello"))});
				process.exit(0);
			}
			process.exit(0);
		`,
			{ namespace: "hobo-system" },
		);
		expect(created.getClaim("hello")?.name).toBe("hello");
	});
});

describe("listing claims", () => {
	it("lists nothing for an empty cluster", () => {
		const created = cluster(`
			if (argv[0] === "get") { process.stdout.write('{"items":[]}'); process.exit(0); }
			process.exit(0);
		`);
		expect(created.claimNames()).toEqual([]);
	});

	it("lists the claims the cluster holds", () => {
		const created = cluster(`
			if (argv[0] === "get") {
				process.stdout.write(JSON.stringify({ items: [
					{ metadata: { name: "b" } },
					{ metadata: { name: "a" } },
				]}));
				process.exit(0);
			}
			process.exit(0);
		`);
		// Sorted, not in API-server order: a receipt whose order depended on the
		// response would differ on every run.
		expect(created.claimNames()).toEqual(["a", "b"]);
	});

	it("skips an item with no name", () => {
		const created = cluster(`
			if (argv[0] === "get") {
				process.stdout.write(JSON.stringify({ items: [{}, { metadata: { name: "a" } }] }));
				process.exit(0);
			}
			process.exit(0);
		`);
		// A nameless claim cannot be addressed, so listing it as an empty string
		// would produce an entry nothing can act on.
		expect(created.claimNames()).toEqual(["a"]);
	});

	it("treats a response with no items key as empty", () => {
		const created = cluster(`
			if (argv[0] === "get") { process.stdout.write("{}"); process.exit(0); }
			process.exit(0);
		`);
		expect(created.claimNames()).toEqual([]);
	});
});

describe("waiting for a claim to become ready", () => {
	it("returns true once the claim reports Ready", () => {
		const created = cluster(`
			if (argv[0] === "get") { process.stdout.write(${JSON.stringify(claimJson("hello", true))}); process.exit(0); }
			process.exit(0);
		`);
		expect(created.waitForReady("hello", 3)).toBe(true);
	});

	it("returns false when the claim never becomes ready", () => {
		const created = cluster(`
			if (argv[0] === "get") { process.stdout.write(${JSON.stringify(claimJson("hello", false))}); process.exit(0); }
			process.exit(0);
		`);
		// A claim still reconciling is a normal state, not an error — the caller
		// decides whether to keep waiting or report drift.
		expect(created.waitForReady("hello", 2)).toBe(false);
	});

	it("returns false when the claim does not exist at all", () => {
		const created = cluster(`
			if (argv[0] === "get") { process.stderr.write("not found"); process.exit(1); }
			process.exit(0);
		`);
		expect(created.waitForReady("hello", 2)).toBe(false);
	});

	it("stops after the poll limit rather than waiting forever", () => {
		const created = cluster(`
			if (argv[0] === "get") { process.stdout.write(${JSON.stringify(claimJson("hello", false))}); process.exit(0); }
			process.exit(0);
		`);
		// An unbounded wait on a claim whose controller is broken would hang a
		// deploy with no output.
		const started = process.hrtime.bigint();
		expect(created.waitForReady("hello", 1)).toBe(false);
		expect(Number(process.hrtime.bigint() - started)).toBeLessThan(5e9);
	});
});

describe("writing and removing claims", () => {
	it("applies a claim through kubectl apply", () => {
		const log = join(tempDir("hobo-xp-log-"), "calls.log");
		const created = cluster(`
			require("node:fs").appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");
			process.exit(0);
		`);
		created.applyClaim({
			name: "hello",
			// SAFETY: the cluster reads exactly the fields a claim names.
		} as never);
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		expect(readFileSync(log, "utf8")).toContain("apply");
	});

	it("deletes a claim without failing when it is already gone", () => {
		const log = join(tempDir("hobo-xp-log-"), "calls.log");
		const created = cluster(`
			require("node:fs").appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");
			process.exit(0);
		`);
		created.deleteClaim("hello");
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		// `--ignore-not-found` makes a repeated destroy idempotent; without it a
		// second teardown fails on a resource that is correctly absent.
		expect(readFileSync(log, "utf8")).toContain("--ignore-not-found=true");
	});

	it("deletes from the configured namespace", () => {
		const log = join(tempDir("hobo-xp-log-"), "calls.log");
		const created = cluster(
			`
			require("node:fs").appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");
			process.exit(0);
		`,
			{ namespace: "hobo-system" },
		);
		created.deleteClaim("hello");
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		expect(readFileSync(log, "utf8")).toContain("hobo-system");
	});

	it("refuses to apply against an unreachable cluster", () => {
		const created = cluster(
			'process.stderr.write("refused"); process.exit(1);',
		);
		// The availability check runs before the write, so a claim is never
		// half-sent to a cluster that cannot take it.
		expect(() => created.applyClaim({ name: "hello" } as never)).toThrow();
	});
});
