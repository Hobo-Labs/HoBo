/**
 * The Kubernetes client over the kubectl PACT transport.
 *
 * This is the layer between HoBo's runtime and the cluster boundary. It owns
 * three things the transport below it does not.
 *
 * **The namespace.** Every request carries it, and it is ensured exactly once
 * per client rather than before every call — a namespace-ensure on each apply
 * would triple the round-trips of a multi-manifest deploy. Once ensured, it
 * stays ensured for the client's life.
 *
 * **The success/failure boundary.** The transport answers with status codes;
 * this layer converts anything at 400 or above into a
 * `KubectlUnavailableError` carrying the transport's own body. A caller that
 * received a 5xx and carried on would deploy against a cluster that refused
 * the manifest.
 *
 * **The one exception is `probe`, which never throws.** It exists to answer
 * "can we reach a cluster?", and an exception there makes the diagnostic
 * unavailable exactly when it is needed. It also separates two facts a single
 * boolean would conflate: whether kubectl is usable (`ready`) and whether a
 * cluster answers (`clusterReachable`) — the fixes are "install kubectl" and
 * "check your kubeconfig", and they are not the same conversation.
 */
import { describe, expect, it } from "vitest";

import {
	type KubectlRequest,
	type KubectlResponse,
	type KubectlTransport,
	KubectlUnavailableError,
} from "../src/kubectl-transport.js";
import { createKubectlKubernetesClient } from "../src/kubernetes-client.js";

/**
 * A transport that records every request and answers from a path table.
 *
 * An unlisted path answers 200 with an empty body, so a test only scripts the
 * calls it cares about.
 */
function fakeTransport(
	table: Record<string, KubectlResponse> = {},
): KubectlTransport & { readonly requests: KubectlRequest[] } {
	const requests: KubectlRequest[] = [];
	return {
		name: "FakeClusterApi",
		requests,
		handle(request) {
			requests.push(request);
			return table[request.path] ?? { status: 200, body: {} };
		},
	};
}

function client(
	table: Record<string, KubectlResponse> = {},
	options: { namespace?: string; ensureNamespace?: boolean } = {},
) {
	const transport = fakeTransport(table);
	return {
		transport,
		client: createKubectlKubernetesClient({ transport, ...options }),
	};
}

/** The bodies sent to one path, in order. */
const bodiesFor = (
	transport: { requests: KubectlRequest[] },
	path: string,
): Record<string, unknown>[] =>
	transport.requests
		.filter((request) => request.path === path)
		.map((request) => (request.body ?? {}) as Record<string, unknown>);

describe("construction", () => {
	it("defaults the namespace and reports it", () => {
		// Every request carries the namespace, so a caller has to be able to
		// read back which one this client is bound to.
		expect(client().client.namespace).toBe("hobo-dev");
		expect(client({}, { namespace: "prod" }).client.namespace).toBe("prod");
	});

	it("exposes the transport it was given and names its kind", () => {
		// The transport is the seam PACT verification drives; hiding it would
		// make the boundary unverifiable from outside.
		const { client: c, transport } = client();
		expect(c.transport).toBe(transport);
		expect(c.kind).toBe("kubectl");
	});
});

describe("namespace ensure", () => {
	it("ensures the namespace before the first mutating call", async () => {
		// Applying into a namespace that does not exist fails at the cluster,
		// with an error about the resource rather than the namespace.
		const { client: c, transport } = client();
		await c.apply([{ kind: "Deployment" }]);
		expect(transport.requests[0]?.path).toBe("/kubectl/namespace/ensure");
		expect(bodiesFor(transport, "/kubectl/namespace/ensure")[0]).toEqual({
			namespace: "hobo-dev",
		});
	});

	it("ensures it only once across many calls", async () => {
		// A namespace-ensure per operation would triple the round-trips of a
		// multi-manifest deploy against a cluster that is already correct.
		const { client: c, transport } = client();
		await c.apply([{ kind: "Deployment" }]);
		await c.apply([{ kind: "Service" }]);
		await c.waitReady("web");
		await c.delete("web");
		expect(bodiesFor(transport, "/kubectl/namespace/ensure")).toHaveLength(1);
	});

	it("skips the ensure entirely when told to", async () => {
		// A caller deploying into a namespace another controller owns must not
		// create or touch it.
		const { client: c, transport } = client({}, { ensureNamespace: false });
		await c.apply([{ kind: "Deployment" }]);
		expect(bodiesFor(transport, "/kubectl/namespace/ensure")).toHaveLength(0);
	});

	it("throws when the ensure fails, before attempting the operation", async () => {
		// An apply into a namespace that could not be created would fail anyway,
		// with a worse message. Failing here names the actual problem.
		const { client: c, transport } = client({
			"/kubectl/namespace/ensure": {
				status: 403,
				body: { error: "forbidden" },
			},
		});
		await expect(c.apply([{ kind: "Deployment" }])).rejects.toThrow(
			KubectlUnavailableError,
		);
		expect(bodiesFor(transport, "/kubectl/apply")).toHaveLength(0);
	});

	it("carries the transport's body into the failure message", async () => {
		// The cluster's own words are the only description of why it refused.
		const { client: c } = client({
			"/kubectl/namespace/ensure": {
				status: 403,
				body: { error: "forbidden" },
			},
		});
		await expect(c.apply([])).rejects.toThrow(/forbidden/);
	});

	it("does not skip the ensure after a failure", async () => {
		// A transient failure must not leave the client believing the namespace
		// is ready — the next call would deploy into nothing.
		const { client: c, transport } = client({
			"/kubectl/namespace/ensure": { status: 503, body: {} },
		});
		await expect(c.apply([])).rejects.toThrow();
		await expect(c.apply([])).rejects.toThrow();
		expect(bodiesFor(transport, "/kubectl/namespace/ensure")).toHaveLength(2);
	});
});

describe("probe", () => {
	it("reports ready and reachable with notes naming the binary", async () => {
		// The notes are what a doctor command prints. Without the binary path a
		// user cannot tell which kubectl answered.
		const { client: c } = client({
			"/kubectl/version": {
				status: 200,
				body: { clientVersion: "v1.31.0", kubectlBin: "/usr/bin/kubectl" },
			},
			"/kubectl/cluster-info": { status: 200, body: { reachable: true } },
		});
		const probe = await c.probe();
		expect(probe.ready).toBe(true);
		expect(probe.clusterReachable).toBe(true);
		expect(probe.clientVersion).toBe("v1.31.0");
		expect(probe.kubectlBin).toBe("/usr/bin/kubectl");
		expect(probe.notes.join(" ")).toContain("/usr/bin/kubectl");
		expect(probe.notes.join(" ")).toContain("cluster reachable");
	});

	it("returns a result rather than throwing when kubectl is unusable", async () => {
		// "Is kubectl installed?" is the question. An exception makes the
		// diagnostic unavailable precisely when it is needed.
		const { client: c } = client({
			"/kubectl/version": { status: 503, body: { error: "not found" } },
		});
		const probe = await c.probe();
		expect(probe.ready).toBe(false);
		expect(probe.kubectlBin).toBeNull();
		expect(probe.clientVersion).toBeNull();
		expect(probe.clusterReachable).toBe(false);
		expect(probe.notes.join(" ")).toContain("kubectl client unavailable");
	});

	it("stops before the cluster check when kubectl itself is unusable", async () => {
		// There is nothing to ask the cluster with. The extra call would fail
		// the same way and add a second, less relevant message.
		const { client: c, transport } = client({
			"/kubectl/version": { status: 503, body: {} },
		});
		await c.probe();
		expect(bodiesFor(transport, "/kubectl/cluster-info")).toHaveLength(0);
	});

	it("separates a usable kubectl from an unreachable cluster", async () => {
		// Two different fixes — "install kubectl" and "check your kubeconfig".
		// A single boolean would send half the users to the wrong one.
		const { client: c } = client({
			"/kubectl/version": { status: 200, body: { clientVersion: "v1.31.0" } },
			"/kubectl/cluster-info": {
				status: 503,
				body: { reachable: false, detail: "connection refused" },
			},
		});
		const probe = await c.probe();
		expect(probe.ready).toBe(true);
		expect(probe.clusterReachable).toBe(false);
		expect(probe.notes.join(" ")).toContain("connection refused");
	});

	it("treats an explicit reachable:false as unreachable even on a 200", async () => {
		// The transport answers 200 for "I ran the command"; the body says what
		// it found. Reading only the status would report a dead cluster as live.
		const { client: c } = client({
			"/kubectl/version": { status: 200, body: { clientVersion: "v1" } },
			"/kubectl/cluster-info": { status: 200, body: { reachable: false } },
		});
		expect((await c.probe()).clusterReachable).toBe(false);
	});

	it("treats a 200 with no reachable field as reachable", async () => {
		// An older transport, or a PACT fixture that omits the field, should not
		// read as a failure — the command succeeded.
		const { client: c } = client({
			"/kubectl/version": { status: 200, body: { clientVersion: "v1" } },
			"/kubectl/cluster-info": { status: 200, body: {} },
		});
		expect((await c.probe()).clusterReachable).toBe(true);
	});

	it("falls back to `ok` in the note when no version string came back", async () => {
		// A note reading "kubectl client undefined" is worse than one saying the
		// client answered.
		const { client: c } = client({
			"/kubectl/version": { status: 200, body: {} },
		});
		const probe = await c.probe();
		expect(probe.clientVersion).toBeNull();
		expect(probe.notes[0]).toContain("kubectl client ok");
	});

	it("does not ensure the namespace", async () => {
		// A probe is a read. Creating a namespace as a side effect of asking
		// whether a cluster is reachable would mutate on a diagnostic.
		const { client: c, transport } = client();
		await c.probe();
		expect(bodiesFor(transport, "/kubectl/namespace/ensure")).toHaveLength(0);
	});
});

describe("apply", () => {
	it("sends the manifests with the client's namespace", async () => {
		const { client: c, transport } = client();
		await c.apply([{ kind: "Deployment" }, { kind: "Service" }]);
		expect(bodiesFor(transport, "/kubectl/apply")[0]).toEqual({
			namespace: "hobo-dev",
			manifests: [{ kind: "Deployment" }, { kind: "Service" }],
		});
	});

	it("throws with the transport's body on failure", async () => {
		// A failed apply applied nothing; a caller that carried on would deploy
		// against a cluster that refused the manifest.
		const { client: c } = client({
			"/kubectl/apply": { status: 500, body: { error: "webhook denied" } },
		});
		await expect(c.apply([{ kind: "Deployment" }])).rejects.toThrow(
			/webhook denied/,
		);
	});
});

describe("waitReady", () => {
	it("passes the workload name and the default timeout", async () => {
		// The default has to be long enough for an image pull; a short one would
		// report a healthy rollout as failed.
		const { client: c, transport } = client();
		await c.waitReady("web");
		expect(bodiesFor(transport, "/kubectl/rollout-status")[0]).toEqual({
			namespace: "hobo-dev",
			name: "web",
			timeoutMs: 120_000,
		});
	});

	it("passes an explicit timeout through", async () => {
		const { client: c, transport } = client();
		await c.waitReady("web", { timeoutMs: 5_000 });
		expect(bodiesFor(transport, "/kubectl/rollout-status")[0]?.timeoutMs).toBe(
			5_000,
		);
	});

	it("throws naming the workload when it does not become ready", async () => {
		// A deploy that reported success over an unready workload would send
		// traffic to pods that are not serving.
		const { client: c } = client({
			"/kubectl/rollout-status": { status: 504, body: { error: "timeout" } },
		});
		await expect(c.waitReady("web")).rejects.toThrow(/'web' not ready/);
	});
});

describe("portForward", () => {
	it("returns the loopback URL and port the transport allocated", async () => {
		const { client: c } = client({
			"/kubectl/port-forward": {
				status: 200,
				body: { loopbackUrl: "http://127.0.0.1:5001", localPort: 5001 },
			},
		});
		const handle = await c.portForward("web", 8080);
		expect(handle.loopbackUrl).toBe("http://127.0.0.1:5001");
		expect(handle.localPort).toBe(5001);
	});

	it("sends the namespace, service, and target port", async () => {
		const { client: c, transport } = client({
			"/kubectl/port-forward": {
				status: 200,
				body: { loopbackUrl: "http://127.0.0.1:1", localPort: 1 },
			},
		});
		await c.portForward("web", 8080);
		expect(bodiesFor(transport, "/kubectl/port-forward")[0]).toEqual({
			namespace: "hobo-dev",
			service: "web",
			targetPort: 8080,
		});
	});

	it("throws when the forward could not be established", async () => {
		// A handle pointing at a port nothing is listening on would turn every
		// later proxied request into a connection refused, far from the cause.
		const { client: c } = client({
			"/kubectl/port-forward": { status: 504, body: { error: "not ready" } },
		});
		await expect(c.portForward("web", 8080)).rejects.toThrow(/not ready/);
	});

	it("closes without throwing, and twice", async () => {
		// Close runs from teardown paths that cannot know whether the forward
		// survived. Throwing there would mask the error being unwound from.
		const { client: c } = client({
			"/kubectl/port-forward": {
				status: 200,
				body: { loopbackUrl: "http://127.0.0.1:1", localPort: 1 },
			},
		});
		const handle = await c.portForward("web", 8080);
		await expect(handle.close()).resolves.toBeUndefined();
		await expect(handle.close()).resolves.toBeUndefined();
	});
});

describe("httpProxy", () => {
	it("forwards method, path, headers, and body", async () => {
		const { client: c, transport } = client({
			"/kubectl/http-proxy": { status: 200, body: { status: 200 } },
		});
		await c.httpProxy({
			service: "web",
			method: "POST",
			path: "/orders",
			headers: { "content-type": "application/json" },
			body: { id: 1 },
		});
		expect(bodiesFor(transport, "/kubectl/http-proxy")[0]).toEqual({
			namespace: "hobo-dev",
			service: "web",
			method: "POST",
			path: "/orders",
			headers: { "content-type": "application/json" },
			body: { id: 1 },
		});
	});

	it("omits headers and body entirely when the caller gave none", async () => {
		// A `body: undefined` on a GET would be serialized as a key the
		// transport then has to reason about, and an empty header map is not the
		// same as no headers.
		const { client: c, transport } = client({
			"/kubectl/http-proxy": { status: 200, body: { status: 200 } },
		});
		await c.httpProxy({ service: "web", method: "GET", path: "/health" });
		const sent = bodiesFor(transport, "/kubectl/http-proxy")[0] ?? {};
		expect("headers" in sent).toBe(false);
		expect("body" in sent).toBe(false);
	});

	it("returns the upstream status, not the transport's", async () => {
		// The transport answers 200 for "I made the call"; the upstream's own
		// 404 is what the caller needs to see.
		const { client: c } = client({
			"/kubectl/http-proxy": {
				status: 200,
				body: { status: 404, headers: { "content-type": "text/plain" } },
			},
		});
		const response = await c.httpProxy({
			service: "web",
			method: "GET",
			path: "/missing",
		});
		expect(response.status).toBe(404);
		expect(response.headers).toEqual({ "content-type": "text/plain" });
	});

	it("carries json or text through, and neither when the body had neither", async () => {
		// A caller distinguishes "parsed JSON" from "raw text" from "no body",
		// and collapsing them would make an empty response look like an empty
		// string.
		const withJson = client({
			"/kubectl/http-proxy": {
				status: 200,
				body: { status: 200, json: { ok: 1 } },
			},
		});
		expect(
			await withJson.client.httpProxy({
				service: "w",
				method: "GET",
				path: "/",
			}),
		).toMatchObject({ json: { ok: 1 } });

		const withText = client({
			"/kubectl/http-proxy": { status: 200, body: { status: 200, text: "hi" } },
		});
		expect(
			await withText.client.httpProxy({
				service: "w",
				method: "GET",
				path: "/",
			}),
		).toMatchObject({ text: "hi" });

		const bare = client({
			"/kubectl/http-proxy": { status: 200, body: { status: 204 } },
		});
		const response = await bare.client.httpProxy({
			service: "w",
			method: "GET",
			path: "/",
		});
		expect("json" in response).toBe(false);
		expect("text" in response).toBe(false);
		expect(response.headers).toEqual({});
	});

	it("throws when the proxy call itself fails", async () => {
		const { client: c } = client({
			"/kubectl/http-proxy": { status: 503, body: { error: "no forward" } },
		});
		await expect(
			c.httpProxy({ service: "web", method: "GET", path: "/" }),
		).rejects.toThrow(/no forward/);
	});

	it("does not ensure the namespace", async () => {
		// The proxy goes through an already-established forward. Ensuring here
		// would add a cluster round-trip to every proxied request.
		const { client: c, transport } = client({
			"/kubectl/http-proxy": { status: 200, body: { status: 200 } },
		});
		await c.httpProxy({ service: "web", method: "GET", path: "/" });
		expect(bodiesFor(transport, "/kubectl/namespace/ensure")).toHaveLength(0);
	});
});

describe("delete", () => {
	it("deletes by name in the client's namespace", async () => {
		const { client: c, transport } = client();
		await c.delete("web");
		expect(bodiesFor(transport, "/kubectl/resources")[0]).toEqual({
			namespace: "hobo-dev",
			name: "web",
		});
		expect(
			transport.requests.find((r) => r.path === "/kubectl/resources")?.method,
		).toBe("DELETE");
	});

	it("throws when the delete fails", async () => {
		// Unlike the transport's best-effort teardown, this layer reports the
		// failure — a caller tearing down a tenant needs to know resources are
		// still there.
		const { client: c } = client({
			"/kubectl/resources": { status: 403, body: { error: "forbidden" } },
		});
		await expect(c.delete("web")).rejects.toThrow(/forbidden/);
	});
});

describe("building its own transport", () => {
	/**
	 * Every test above injects a transport. These cover the other
	 * construction: no transport given, so the client builds a process
	 * kubectl one from whatever binary and context it was configured with.
	 *
	 * That path is what a Camp actually runs — an injected transport is the
	 * PACT test double — so leaving it unexercised would mean the production
	 * wiring is the only wiring nothing checks.
	 */
	it("builds a process transport when none is injected", () => {
		// The transport names the boundary it implements, so an operator
		// reading a probe's notes can tell which side answered.
		expect(createKubectlKubernetesClient().transport.name).toBe(
			"KubernetesClusterApi",
		);
	});

	it("passes an explicit binary through to it", () => {
		expect(() =>
			createKubectlKubernetesClient({ kubectlBin: "/opt/bin/kubectl" }),
		).not.toThrow();
	});

	it("passes an explicit context through to it", () => {
		// The context selects which cluster every later call reaches; dropping
		// it would silently target whatever kubeconfig names as current.
		expect(() =>
			createKubectlKubernetesClient({ context: "staging" }),
		).not.toThrow();
	});

	it("passes an explicit environment through to it", () => {
		expect(() =>
			createKubectlKubernetesClient({ env: { PATH: "/usr/bin" } }),
		).not.toThrow();
	});

	it("builds one with no options at all", () => {
		// The zero-config path: a Camp with kubectl on PATH and a single
		// context should not have to configure anything.
		expect(createKubectlKubernetesClient().namespace).toBe("hobo-dev");
	});

	it("still honours an injected transport over building one", () => {
		// Injection is how the PACT mock provider substitutes for a cluster; a
		// client that built its own anyway would shell out during a contract
		// test.
		const injected: KubectlTransport = {
			name: "InjectedApi",
			handle: async () => ({ status: 200, body: {} }),
		};
		expect(
			createKubectlKubernetesClient({ transport: injected }).transport.name,
		).toBe("InjectedApi");
	});
});
