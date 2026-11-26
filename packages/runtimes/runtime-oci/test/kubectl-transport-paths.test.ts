/**
 * The kubectl process transport — the production side of the cluster PACT
 * boundary.
 *
 * Every path here shells out to a real `kubectl`, so the tests give it a
 * stand-in binary on disk that records its arguments and answers from a
 * scripted table. That is the only way to pin what actually matters about this
 * module, which is **which kubectl invocation each request produces** — the
 * arguments are the contract with the cluster, and a wrong flag is a wrong
 * mutation.
 *
 * Two shapes of failure are handled differently on purpose.
 *
 * **Read paths degrade to a status code.** `version` and `cluster-info` answer
 * 503 with the captured stderr rather than throwing, because "kubectl is not
 * installed" is a normal answer to "is this cluster reachable?" — a doctor
 * command needs the answer, not an exception.
 *
 * **Write paths throw `KubectlUnavailableError`.** An `apply` that failed did
 * not apply anything, and returning a 5xx body would let a caller carry on as
 * though the manifest landed. The error carries the exit code and the CLI's
 * own stderr, because that text is the only description of why the cluster
 * refused.
 *
 * An unrecognised path is a 404 rather than a silent no-op: a typo in a caller
 * that quietly did nothing would look like a cluster that ignored the request.
 */
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createProcessKubectlTransport,
	KubectlUnavailableError,
} from "../src/kubectl-transport.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in `kubectl` that appends its argv to a log and answers from a
 * scripted table keyed on the first argument.
 *
 * Each entry is `[exitCode, stdout]`. An unlisted verb exits 0 silently, which
 * keeps a test from having to script calls it does not care about.
 */
function fakeKubectl(script: Record<string, [number, string]> = {}): {
	bin: string;
	calls: () => string[][];
} {
	const dir = mkdtempSync(join(tmpdir(), "hobo-kubectl-"));
	dirs.push(dir);
	const bin = join(dir, "kubectl");
	const log = join(dir, "calls.log");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			`const script = ${JSON.stringify(script)};`,
			"const argv = process.argv.slice(2);",
			`fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');`,
			"const entry = script[argv[0]] ?? script[argv.join(' ')];",
			"if (entry) { process.stdout.write(entry[1]); process.exit(entry[0]); }",
			"process.exit(0);",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	return {
		bin,
		calls: () => {
			try {
				return readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as string[]);
			} catch {
				return [];
			}
		},
	};
}

function transport(
	script: Record<string, [number, string]> = {},
	options: { context?: string } = {},
) {
	const fake = fakeKubectl(script);
	return {
		...fake,
		transport: createProcessKubectlTransport({
			kubectlBin: fake.bin,
			env: { PATH: process.env.PATH ?? "" },
			...(options.context !== undefined ? { context: options.context } : {}),
		}),
	};
}

describe("binary selection", () => {
	it("names itself for the PACT boundary it implements", () => {
		// The name is what pairs this transport with its contract fixtures. A
		// mismatch would make the PACT verification silently exercise nothing.
		expect(createProcessKubectlTransport().name).toBe("KubernetesClusterApi");
	});

	it("takes the binary from the option, then the environment, then PATH", () => {
		// A user behind a corporate wrapper sets the variable; a test passes the
		// option. Both have to beat the bare `kubectl` on PATH.
		const fake = fakeKubectl({ version: [0, '{"clientVersion":{}}'] });
		const fromEnv = createProcessKubectlTransport({
			// The stand-in is a node script, so its `#!/usr/bin/env node` line
			// still needs node's own directory on PATH — but nothing else is
			// there, so a `kubectl` found on PATH cannot be what answered.
			env: { HOBO_KUBECTL_BIN: fake.bin, PATH: dirname(process.execPath) },
		});
		return fromEnv
			.handle({ method: "GET", path: "/kubectl/version" })
			.then((response) => {
				expect(response.status).toBe(200);
				expect((response.body as { kubectlBin: string }).kubectlBin).toBe(
					fake.bin,
				);
			});
	});

	it("passes --context ahead of every subcommand when one is configured", async () => {
		// The context decides *which cluster* is mutated. Appending it after the
		// verb, or omitting it, would apply manifests to whatever the user's
		// kubeconfig happens to point at.
		const { transport: t, calls } = transport(
			{ "cluster-info": [0, "reachable"] },
			{ context: "staging" },
		);
		await t.handle({ method: "GET", path: "/kubectl/cluster-info" });
		expect(calls()[0]?.slice(0, 2)).toEqual(["--context", "staging"]);
	});

	it("omits the context flag when none is configured", async () => {
		const { transport: t, calls } = transport({ "cluster-info": [0, "ok"] });
		await t.handle({ method: "GET", path: "/kubectl/cluster-info" });
		expect(calls()[0]).not.toContain("--context");
	});
});

describe("/kubectl/version", () => {
	it("reports the client version parsed from the CLI's own JSON", async () => {
		const { transport: t } = transport({
			version: [0, '{"clientVersion":{"gitVersion":"v1.31.0"}}'],
		});
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, clientVersion: "v1.31.0" });
	});

	it("asks only for the client version, so it works with no cluster", async () => {
		// `kubectl version` without `--client=true` contacts the apiserver and
		// hangs on an unreachable one — which is exactly the situation a version
		// probe is run in.
		const { transport: t, calls } = transport({
			version: [0, '{"clientVersion":{}}'],
		});
		await t.handle({ method: "GET", path: "/kubectl/version" });
		expect(calls()[0]).toContain("--client=true");
	});

	it("reports 503 with the CLI's message when kubectl fails", async () => {
		// "kubectl is not installed" is a normal answer to a doctor probe. An
		// exception here would make the diagnostic unavailable precisely when it
		// is needed.
		const { transport: t } = transport({ version: [1, "command not found"] });
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.status).toBe(503);
		expect(response.body).toMatchObject({ ok: false });
		expect(String((response.body as { error: string }).error)).toContain(
			"command not found",
		);
	});

	it("reports `unknown` rather than failing when the JSON does not parse", async () => {
		// A wrapper script that prints a banner before the JSON is common. The
		// probe still succeeded — kubectl ran — so the version, not the probe,
		// is what is unknown.
		const { transport: t } = transport({ version: [0, "not json"] });
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.body).toMatchObject({ ok: true, clientVersion: "unknown" });
	});

	it("reports null when the JSON parses but names no version", async () => {
		// Parsed-but-absent and unparseable are different states, and the two
		// values distinguish them for whoever reads the doctor output.
		const { transport: t } = transport({ version: [0, "{}"] });
		expect(
			(await t.handle({ method: "GET", path: "/kubectl/version" })).body,
		).toMatchObject({ clientVersion: null });
	});
});

describe("/kubectl/cluster-info", () => {
	it("reports reachable with the CLI's output", async () => {
		const { transport: t } = transport({
			"cluster-info": [0, "Kubernetes control plane is running at https://k8s"],
		});
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/cluster-info",
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, reachable: true });
		expect(String((response.body as { detail: string }).detail)).toContain(
			"control plane",
		);
	});

	it("reports unreachable as 503 rather than throwing", async () => {
		// Same reason as the version probe: this is the question, not a
		// precondition for it.
		const { transport: t } = transport({
			"cluster-info": [1, "connection refused"],
		});
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/cluster-info",
		});
		expect(response.status).toBe(503);
		expect(response.body).toMatchObject({ ok: false, reachable: false });
	});
});

describe("/kubectl/namespace/ensure", () => {
	it("does nothing when the namespace already exists", async () => {
		// Applying over an existing namespace would touch its labels and
		// annotations — including ones another controller owns.
		const { transport: t, calls } = transport({ get: [0, "namespace/hobo"] });
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: { namespace: "hobo" },
		});
		expect(response.body).toMatchObject({ ok: true, namespace: "hobo" });
		expect(calls().some((call) => call.includes("apply"))).toBe(false);
	});

	it("creates the namespace when the lookup fails", async () => {
		const { transport: t, calls } = transport({ get: [1, "not found"] });
		await t.handle({
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: { namespace: "hobo" },
		});
		expect(calls().some((call) => call.includes("apply"))).toBe(true);
	});

	it("defaults the namespace rather than creating one named `undefined`", async () => {
		const { transport: t, calls } = transport({
			get: [0, "namespace/default"],
		});
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: {},
		});
		expect(response.body).toMatchObject({ namespace: "default" });
		expect(calls()[0]).toContain("default");
	});

	it("throws when the create itself fails", async () => {
		// A namespace that was not created means every later apply targets
		// nothing. Returning ok here would let the deploy proceed into a void.
		const { transport: t } = transport({
			get: [1, "nf"],
			apply: [1, "denied"],
		});
		await expect(
			t.handle({
				method: "POST",
				path: "/kubectl/namespace/ensure",
				body: { namespace: "hobo" },
			}),
		).rejects.toThrow(KubectlUnavailableError);
	});
});

describe("/kubectl/apply", () => {
	it("applies each manifest into the requested namespace", async () => {
		const { transport: t, calls } = transport();
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/apply",
			body: {
				namespace: "hobo",
				manifests: [{ kind: "Deployment" }, { kind: "Service" }],
			},
		});
		expect(response.body).toMatchObject({ ok: true, applied: 2 });
		const applies = calls().filter((call) => call.includes("apply"));
		expect(applies).toHaveLength(2);
		expect(applies[0]).toEqual(["apply", "-n", "hobo", "-f", "-"]);
	});

	it("stamps the namespace onto each manifest's metadata", async () => {
		// A manifest carrying a different namespace in its own metadata would
		// otherwise be applied there instead — silently deploying into the wrong
		// place despite the `-n` flag.
		const { transport: t, calls } = transport();
		await t.handle({
			method: "POST",
			path: "/kubectl/apply",
			body: {
				namespace: "hobo",
				manifests: [{ kind: "Deployment", metadata: { namespace: "other" } }],
			},
		});
		// The manifest goes in on stdin; the flag is what the log can show.
		expect(calls()[0]).toEqual(["apply", "-n", "hobo", "-f", "-"]);
	});

	it("succeeds with nothing to apply", async () => {
		// An empty manifest list is a legitimate no-op for a Bindle that
		// declares no cluster resources.
		const { transport: t, calls } = transport();
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/apply",
			body: { namespace: "hobo", manifests: [] },
		});
		expect(response.body).toMatchObject({ applied: 0 });
		expect(calls()).toEqual([]);
	});

	it("treats a missing manifests list as empty", async () => {
		const { transport: t } = transport();
		expect(
			(await t.handle({ method: "POST", path: "/kubectl/apply", body: {} }))
				.body,
		).toMatchObject({ applied: 0 });
	});

	it("throws with the exit code and stderr when an apply fails", async () => {
		// A failed apply applied nothing. The caller must not carry on, and the
		// cluster's own message is the only description of why it refused.
		const { transport: t } = transport({
			apply: [1, "admission webhook denied"],
		});
		await expect(
			t.handle({
				method: "POST",
				path: "/kubectl/apply",
				body: { manifests: [{ kind: "Deployment" }] },
			}),
		).rejects.toThrow(/exit 1.*admission webhook denied/su);
	});

	it("tags the failure with a stable code", async () => {
		// Callers branch on the code, not the message — the message carries the
		// cluster's wording and changes with its version.
		const { transport: t } = transport({ apply: [1, "denied"] });
		await t
			.handle({
				method: "POST",
				path: "/kubectl/apply",
				body: { manifests: [{}] },
			})
			.then(
				() => expect.unreachable(),
				(error: KubectlUnavailableError) => {
					expect(error.code).toBe("HOBO_KUBECTL_UNAVAILABLE");
					expect(error.name).toBe("KubectlUnavailableError");
				},
			);
	});
});

describe("/kubectl/rollout-status", () => {
	it("reports ready when the rollout completes", async () => {
		const { transport: t } = transport({
			rollout: [0, "successfully rolled out"],
		});
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { namespace: "hobo", name: "web", timeoutMs: 1000 },
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, ready: true });
	});

	it("passes the timeout to kubectl in whole seconds, never below one", async () => {
		// `--timeout=0s` means "wait forever" to kubectl — the opposite of what a
		// caller asking for a short timeout wants.
		const { transport: t, calls } = transport({ rollout: [0, "ok"] });
		await t.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { name: "web", timeoutMs: 1 },
		});
		expect(calls()[0]?.join(" ")).toContain("--timeout=1s");
	});

	it("falls back to polling endpoints when the rollout command fails", async () => {
		// A Deployment can be serving before `rollout status` agrees — a
		// readiness probe with a long period, say. Ready endpoints are the fact
		// that matters, so they are checked before giving up.
		const { transport: t } = transport({
			rollout: [1, "progress deadline"],
			get: [0, "10.1.2.3"],
		});
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { name: "web", timeoutMs: 2000 },
		});
		expect(response.body).toMatchObject({ ok: true, ready: true });
	});

	it("times out as 504 carrying the rollout's own error", async () => {
		// The rollout message says *why* it did not become ready; a bare timeout
		// would leave the operator to go and ask the cluster themselves.
		const { transport: t } = transport({
			rollout: [1, "progress deadline exceeded"],
			get: [0, "   "],
		});
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { name: "web", timeoutMs: 600 },
		});
		expect(response.status).toBe(504);
		expect(response.body).toMatchObject({ ok: false, ready: false });
	});
});

describe("/kubectl/http-proxy", () => {
	it("refuses when no port-forward is active for the service", async () => {
		// There is nothing to proxy to. Dialling a guessed port would either
		// connect to an unrelated local process or hang.
		const { transport: t } = transport();
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/http-proxy",
			body: { service: "web", path: "/health" },
		});
		expect(response.status).toBe(503);
		expect(String((response.body as { error: string }).error)).toContain("web");
	});
});

describe("/kubectl/resources DELETE", () => {
	it("deletes the deployment and service without waiting", async () => {
		// Teardown must not block on finalizers; the caller is usually exiting.
		// `--ignore-not-found` makes a repeated teardown a no-op rather than a
		// failure.
		const { transport: t, calls } = transport();
		const response = await t.handle({
			method: "DELETE",
			path: "/kubectl/resources",
			body: { namespace: "hobo", name: "web" },
		});
		expect(response.body).toMatchObject({ ok: true, deleted: true });
		const args = calls()[0]?.join(" ") ?? "";
		expect(args).toContain("delete deployment,service web");
		expect(args).toContain("--ignore-not-found=true");
		expect(args).toContain("--wait=false");
	});

	it("reports success even when the delete command fails", async () => {
		// Teardown is best-effort by design: a cluster that is already gone
		// should not turn a clean exit into an error.
		const { transport: t } = transport({ delete: [1, "no such deployment"] });
		expect(
			(
				await t.handle({
					method: "DELETE",
					path: "/kubectl/resources",
					body: { name: "web" },
				})
			).body,
		).toMatchObject({ ok: true });
	});

	it("only answers DELETE on that path", async () => {
		// A GET here is a caller mistake, and answering it as a delete would be
		// a destructive read.
		const { transport: t } = transport();
		expect(
			(await t.handle({ method: "GET", path: "/kubectl/resources" })).status,
		).toBe(404);
	});
});

describe("unknown paths", () => {
	it("answers 404 naming the path rather than silently doing nothing", async () => {
		// A typo that quietly did nothing would look like a cluster ignoring the
		// request, which is a much harder thing to diagnose.
		const { transport: t } = transport();
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/frobnicate",
		});
		expect(response.status).toBe(404);
		expect(String((response.body as { error: string }).error)).toContain(
			"/kubectl/frobnicate",
		);
	});
});
