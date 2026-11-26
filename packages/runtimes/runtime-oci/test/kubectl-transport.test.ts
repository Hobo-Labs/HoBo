/**
 * The kubectl process transport.
 *
 * This is the production side of the kubectl PACT boundary, and it is normally
 * untestable-looking because it shells out. It isn't: `kubectlBin` is
 * injectable, so pointing it at a stub script exercises the real `spawnSync`
 * path, the real argument construction and the real output parsing — without a
 * cluster, and without mocking `node:child_process` (which would test the mock
 * rather than the code).
 *
 * The branches that matter here are the failure translations. This transport
 * sits between a cluster that fails in many ways and callers that need a small
 * number of distinguishable outcomes, so what it *does with* a non-zero exit is
 * the whole contract:
 *
 *   - an unreachable cluster becomes 503, not a throw;
 *   - unparseable version JSON degrades to "unknown" rather than failing, since
 *     a kubectl that printed something unexpected is still a kubectl;
 *   - but a failed *write* throws `KubectlUnavailableError`, because silently
 *     reporting success for an apply that did not happen is the one outcome
 *     nobody can recover from.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	createProcessKubectlTransport,
	KubectlUnavailableError,
} from "../src/kubectl-transport.js";

/**
 * Write a stub `kubectl` that echoes a canned stdout and exits with a chosen
 * code. Argument-dependent behaviour is expressed as a shell case so one stub
 * can serve a whole scenario.
 */
function stubKubectl(script: string): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-kubectl-"));
	const bin = join(dir, "kubectl");
	writeFileSync(bin, `#!/bin/sh\n${script}\n`);
	chmodSync(bin, 0o755);
	return bin;
}

const ok = (stdout: string) => stubKubectl(`printf '%s' '${stdout}'\nexit 0`);
const fails = (stderr: string) =>
	stubKubectl(`printf '%s' '${stderr}' >&2\nexit 1`);

function transport(bin: string, context?: string) {
	return createProcessKubectlTransport({
		kubectlBin: bin,
		env: {},
		...(context !== undefined ? { context } : undefined),
	});
}

describe("the transport's identity", () => {
	it("names the boundary it implements", () => {
		expect(transport(ok("")).name).toBe("KubernetesClusterApi");
	});

	it("takes the binary from the environment when not passed", async () => {
		const bin = ok('{"clientVersion":{"gitVersion":"v1.30.0"}}');
		const port = createProcessKubectlTransport({
			env: { HOBO_KUBECTL_BIN: bin },
		});
		const response = await port.handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.status).toBe(200);
	});
});

describe("/kubectl/version", () => {
	it("reports the parsed client version", async () => {
		const response = await transport(
			ok('{"clientVersion":{"gitVersion":"v1.30.0"}}'),
		).handle({ method: "GET", path: "/kubectl/version" });
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, clientVersion: "v1.30.0" });
	});

	it("reports which binary answered, so a surprising version is traceable", async () => {
		const bin = ok('{"clientVersion":{"gitVersion":"v1.30.0"}}');
		const response = await transport(bin).handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.body).toMatchObject({ kubectlBin: bin });
	});

	it('degrades to "unknown" rather than failing on unparseable output', async () => {
		// A kubectl that printed something unexpected is still a kubectl. Failing
		// here would make a cosmetic output change look like an outage.
		const response = await transport(ok("not json at all")).handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.body).toMatchObject({ ok: true, clientVersion: "unknown" });
	});

	it("reports null when the JSON parses but carries no version", async () => {
		const response = await transport(ok('{"serverVersion":{}}')).handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.body).toMatchObject({ clientVersion: null });
	});

	it("returns 503 rather than throwing when kubectl fails", async () => {
		const response = await transport(fails("no kubectl here")).handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.status).toBe(503);
		expect(response.body).toMatchObject({ ok: false });
	});

	it("returns 503 when the binary does not exist at all", async () => {
		// spawnSync reports an error rather than an exit code here, and the
		// transport has to translate that too.
		const response = await transport("/nonexistent/kubectl").handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.status).toBe(503);
	});
});

describe("/kubectl/cluster-info", () => {
	it("reports a reachable cluster", async () => {
		const response = await transport(
			ok("Kubernetes control plane is running"),
		).handle({ method: "GET", path: "/kubectl/cluster-info" });
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, reachable: true });
	});

	it("reports an unreachable cluster as 503 rather than throwing", async () => {
		const response = await transport(fails("connection refused")).handle({
			method: "GET",
			path: "/kubectl/cluster-info",
		});
		expect(response.status).toBe(503);
		expect(response.body).toMatchObject({ reachable: false });
	});

	it("carries the detail through, so the reason is visible", async () => {
		const response = await transport(fails("connection refused")).handle({
			method: "GET",
			path: "/kubectl/cluster-info",
		});
		expect(response.body).toMatchObject({ detail: "connection refused" });
	});
});

describe("/kubectl/namespace/ensure", () => {
	it("does not create a namespace that already exists", async () => {
		// `get` succeeding means it is there; applying anyway would be a
		// needless write against a cluster.
		const bin = stubKubectl(`
case "$1" in
  get) printf 'namespace/prod'; exit 0 ;;
  apply) printf 'should not apply' >&2; exit 3 ;;
esac
exit 0`);
		const response = await transport(bin).handle({
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: { namespace: "prod" },
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, namespace: "prod" });
	});

	it("creates the namespace when it is missing", async () => {
		const bin = stubKubectl(`
case "$1" in
  get) exit 1 ;;
  apply) printf 'namespace/prod created'; exit 0 ;;
esac
exit 0`);
		const response = await transport(bin).handle({
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: { namespace: "prod" },
		});
		expect(response.body).toMatchObject({ ok: true, namespace: "prod" });
	});

	it("defaults the namespace when none is given", async () => {
		const response = await transport(ok("namespace/default")).handle({
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: {},
		});
		expect(response.body).toMatchObject({ namespace: "default" });
	});

	it("throws when creating the namespace fails", async () => {
		// A write that did not happen must not report success.
		const bin = stubKubectl(`
case "$1" in
  get) exit 1 ;;
  apply) printf 'forbidden' >&2; exit 1 ;;
esac
exit 0`);
		await expect(
			transport(bin).handle({
				method: "POST",
				path: "/kubectl/namespace/ensure",
				body: { namespace: "prod" },
			}),
		).rejects.toThrow(KubectlUnavailableError);
	});
});

describe("/kubectl/apply", () => {
	it("applies every manifest and reports the count", async () => {
		const response = await transport(ok("configured")).handle({
			method: "POST",
			path: "/kubectl/apply",
			body: {
				namespace: "prod",
				manifests: [{ kind: "Service" }, { kind: "Deployment" }],
			},
		});
		expect(response.body).toMatchObject({ ok: true, applied: 2 });
	});

	it("accepts an empty manifest list without calling kubectl", async () => {
		const response = await transport(fails("would fail if called")).handle({
			method: "POST",
			path: "/kubectl/apply",
			body: { manifests: [] },
		});
		expect(response.body).toMatchObject({ ok: true, applied: 0 });
	});

	it("treats a missing manifest list as empty", async () => {
		const response = await transport(fails("would fail if called")).handle({
			method: "POST",
			path: "/kubectl/apply",
			body: {},
		});
		expect(response.body).toMatchObject({ applied: 0 });
	});

	it("throws when an apply fails, rather than reporting a partial success", async () => {
		await expect(
			transport(fails("invalid manifest")).handle({
				method: "POST",
				path: "/kubectl/apply",
				body: { manifests: [{ kind: "Service" }] },
			}),
		).rejects.toThrow(KubectlUnavailableError);
	});

	it("names the failing command and exit code in the error", async () => {
		// An error that says only "kubectl failed" sends someone to the cluster
		// to find out what.
		await expect(
			transport(fails("invalid manifest")).handle({
				method: "POST",
				path: "/kubectl/apply",
				body: { manifests: [{ kind: "Service" }] },
			}),
		).rejects.toThrow(/apply.*exit 1.*invalid manifest/su);
	});
});

describe("/kubectl/rollout-status", () => {
	it("reports ready when the rollout succeeds", async () => {
		const response = await transport(
			ok("deployment successfully rolled out"),
		).handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { namespace: "prod", name: "web" },
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, ready: true });
	});

	it("falls back to endpoints when rollout status fails but the service has addresses", async () => {
		// A Deployment that rolled out under a different controller can still be
		// serving; endpoints are the ground truth.
		const bin = stubKubectl(`
case "$1" in
  rollout) printf 'no status' >&2; exit 1 ;;
  get) printf '10.0.0.1'; exit 0 ;;
esac
exit 0`);
		const response = await transport(bin).handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { namespace: "prod", name: "web", timeoutMs: 5_000 },
		});
		expect(response.body).toMatchObject({ ok: true, ready: true });
	});

	it("times out with 504 when neither rollout nor endpoints ever succeed", async () => {
		const bin = stubKubectl(`printf 'nope' >&2\nexit 1`);
		const response = await transport(bin).handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { namespace: "prod", name: "web", timeoutMs: 1 },
		});
		expect(response.status).toBe(504);
		expect(response.body).toMatchObject({ ok: false, ready: false });
	});

	it("reports the rollout's own error on timeout, not a generic one", async () => {
		const bin = stubKubectl(`printf 'image pull backoff' >&2\nexit 1`);
		const response = await transport(bin).handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { name: "web", timeoutMs: 1 },
		});
		expect(response.body).toMatchObject({ error: "image pull backoff" });
	});

	it("does not treat blank endpoint output as ready", async () => {
		// jsonpath prints nothing when there are no addresses. Treating that as
		// success would report a Deployment ready with nothing behind it.
		const bin = stubKubectl(`
case "$1" in
  rollout) exit 1 ;;
  get) printf ''; exit 0 ;;
esac
exit 1`);
		const response = await transport(bin).handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { name: "web", timeoutMs: 1 },
		});
		expect(response.status).toBe(504);
	});
});

describe("an unrecognised path", () => {
	it("does not silently succeed", async () => {
		const response = await transport(ok("")).handle({
			method: "GET",
			path: "/kubectl/not-a-real-endpoint",
		});
		expect(response.status).not.toBe(200);
	});
});

describe("KubectlUnavailableError", () => {
	it("carries a stable code callers can switch on", () => {
		const error = new KubectlUnavailableError("gone");
		expect(error.code).toBe("HOBO_KUBECTL_UNAVAILABLE");
		expect(error.name).toBe("KubectlUnavailableError");
		expect(error).toBeInstanceOf(Error);
	});
});
