import { describe, expect, it } from "vitest";

import {
	type KubectlRequest,
	type KubectlResponse,
	type KubectlTransport,
	KubectlUnavailableError,
} from "../src/kubectl-transport.js";
import { createKubectlKubernetesClient } from "../src/kubernetes-client.js";

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

const bodiesFor = (
	transport: { requests: KubectlRequest[] },
	path: string,
): Record<string, unknown>[] =>
	transport.requests
		.filter((request) => request.path === path)
		.map((request) => (request.body ?? {}) as Record<string, unknown>);

describe("construction", () => {
	it("defaults the namespace and reports it", () => {
		expect(client().client.namespace).toBe("hobo-dev");
		expect(client({}, { namespace: "prod" }).client.namespace).toBe("prod");
	});

	it("exposes the transport it was given and names its kind", () => {
		const { client: c, transport } = client();
		expect(c.transport).toBe(transport);
		expect(c.kind).toBe("kubectl");
	});
});

describe("namespace ensure", () => {
	it("ensures the namespace before the first mutating call", async () => {
		const { client: c, transport } = client();
		await c.apply([{ kind: "Deployment" }]);
		expect(transport.requests[0]?.path).toBe("/kubectl/namespace/ensure");
		expect(bodiesFor(transport, "/kubectl/namespace/ensure")[0]).toEqual({
			namespace: "hobo-dev",
		});
	});

	it("ensures it only once across many calls", async () => {
		const { client: c, transport } = client();
		await c.apply([{ kind: "Deployment" }]);
		await c.apply([{ kind: "Service" }]);
		await c.waitReady("web");
		await c.delete("web");
		expect(bodiesFor(transport, "/kubectl/namespace/ensure")).toHaveLength(1);
	});

	it("skips the ensure entirely when told to", async () => {
		const { client: c, transport } = client({}, { ensureNamespace: false });
		await c.apply([{ kind: "Deployment" }]);
		expect(bodiesFor(transport, "/kubectl/namespace/ensure")).toHaveLength(0);
	});

	it("throws when the ensure fails, before attempting the operation", async () => {
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
		const { client: c } = client({
			"/kubectl/namespace/ensure": {
				status: 403,
				body: { error: "forbidden" },
			},
		});
		await expect(c.apply([])).rejects.toThrow(/forbidden/);
	});

	it("does not skip the ensure after a failure", async () => {
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
		const { client: c, transport } = client({
			"/kubectl/version": { status: 503, body: {} },
		});
		await c.probe();
		expect(bodiesFor(transport, "/kubectl/cluster-info")).toHaveLength(0);
	});

	it("separates a usable kubectl from an unreachable cluster", async () => {
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
		const { client: c } = client({
			"/kubectl/version": { status: 200, body: { clientVersion: "v1" } },
			"/kubectl/cluster-info": { status: 200, body: { reachable: false } },
		});
		expect((await c.probe()).clusterReachable).toBe(false);
	});

	it("treats a 200 with no reachable field as reachable", async () => {
		const { client: c } = client({
			"/kubectl/version": { status: 200, body: { clientVersion: "v1" } },
			"/kubectl/cluster-info": { status: 200, body: {} },
		});
		expect((await c.probe()).clusterReachable).toBe(true);
	});

	it("falls back to `ok` in the note when no version string came back", async () => {
		const { client: c } = client({
			"/kubectl/version": { status: 200, body: {} },
		});
		const probe = await c.probe();
		expect(probe.clientVersion).toBeNull();
		expect(probe.notes[0]).toContain("kubectl client ok");
	});

	it("does not ensure the namespace", async () => {
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
		const { client: c } = client({
			"/kubectl/port-forward": { status: 504, body: { error: "not ready" } },
		});
		await expect(c.portForward("web", 8080)).rejects.toThrow(/not ready/);
	});

	it("closes without throwing, and twice", async () => {
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
		const { client: c, transport } = client({
			"/kubectl/http-proxy": { status: 200, body: { status: 200 } },
		});
		await c.httpProxy({ service: "web", method: "GET", path: "/health" });
		const sent = bodiesFor(transport, "/kubectl/http-proxy")[0] ?? {};
		expect("headers" in sent).toBe(false);
		expect("body" in sent).toBe(false);
	});

	it("returns the upstream status, not the transport's", async () => {
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
		const { client: c } = client({
			"/kubectl/resources": { status: 403, body: { error: "forbidden" } },
		});
		await expect(c.delete("web")).rejects.toThrow(/forbidden/);
	});
});

describe("building its own transport", () => {
	it("builds a process transport when none is injected", () => {
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
		expect(createKubectlKubernetesClient().namespace).toBe("hobo-dev");
	});

	it("still honours an injected transport over building one", () => {
		const injected: KubectlTransport = {
			name: "InjectedApi",
			handle: async () => ({ status: 200, body: {} }),
		};
		expect(
			createKubectlKubernetesClient({ transport: injected }).transport.name,
		).toBe("InjectedApi");
	});
});
