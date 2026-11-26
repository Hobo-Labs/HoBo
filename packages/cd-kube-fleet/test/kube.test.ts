// The Kubernetes API client (credentials, error mapping, watch parsing) and
// the plan-resource → object parse boundary.

import { create } from "@bufbuild/protobuf";
import type { TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { parseKubeHub } from "../src/config.js";
import { HubKind, KubeAuth, KubeHubRecordSchema } from "../src/index.js";
import { bearerFrom, createKubeApi, credentialScope } from "../src/kube/api.js";
import { campSlug, renderObjects } from "../src/kube/objects.js";
import {
	credentials,
	deployment,
	now,
	resolvedSet,
	volume,
} from "./fixtures.js";

const kubeHub = (auth = KubeAuth.BEARER) =>
	parseKubeHub(
		create(KubeHubRecordSchema, {
			schemaVersion: "hobo.cd-kube-fleet.hub/v1",
			name: "hub-a",
			kind: HubKind.OCM,
			apiBaseUrl: "https://hub.example:6443",
			credentialRef: "secret://kube/hub-a",
			auth,
		}),
	);

function transport(status: number, body = "{}") {
	const seen: TransportRequest[] = [];
	const http = async (request: TransportRequest) => {
		seen.push(request);
		return { status, headers: {}, body };
	};
	return { http, seen };
}

describe("Kubernetes API client", () => {
	it("sends the resolved bearer token in the Authorization header only, with bounded time and size", async () => {
		const { http, seen } = transport(200, '{"kind":"Thing"}');
		const creds = credentials("t0k3n");
		const api = createKubeApi({
			hub: kubeHub(),
			http,
			credentials: creds,
			now,
		});
		await api.get("/api/v1/namespaces/a/configmaps/b");
		expect(seen[0]?.headers.authorization).toBe("Bearer t0k3n");
		expect(seen[0]?.url).toBe(
			"https://hub.example:6443/api/v1/namespaces/a/configmaps/b",
		);
		expect(seen[0]?.timeoutMs).toBe(15_000);
		expect(seen[0]?.maxResponseBytes).toBeGreaterThan(0);
		expect(creds.calls).toEqual([["secret://kube/hub-a", "kube-api:hub-a"]]);
	});

	it("asks the host for an exec credential under the exec scope", () => {
		expect(credentialScope(kubeHub(KubeAuth.EXEC))).toBe("kube-exec:hub-a");
	});

	it.each([
		[{ token: "" }, "kube-credential-missing"],
		[
			{ clientCertificateData: "x", clientKeyData: "y" },
			"kube-credential-unsupported",
		],
		[
			{ token: "t", expirationTimestamp: "2026-11-12T09:59:59Z" },
			"kube-credential-expired",
		],
		[
			{ token: "t", expirationTimestamp: "not-a-date" },
			"kube-credential-expired",
		],
	])("refuses credential %j with %s", (resolved, code) => {
		expect(() => bearerFrom(resolved, "ref", now())).toThrow(
			expect.objectContaining({ code }),
		);
	});

	it("accepts an exec credential that has not expired", () => {
		expect(
			bearerFrom(
				{ token: "t", expirationTimestamp: "2026-11-12T11:00:00Z" },
				"ref",
				now(),
			),
		).toBe("t");
	});

	it.each([
		[401, "kube-auth-failed"],
		[403, "kube-auth-failed"],
		[409, "kube-conflict"],
		[422, "kube-response-invalid"],
		[429, "kube-unavailable"],
		[503, "kube-unavailable"],
	])("maps HTTP %i to %s", async (status, code) => {
		const { http } = transport(status, '{"message":"nope"}');
		const api = createKubeApi({
			hub: kubeHub(),
			http,
			credentials: credentials(),
			now,
		});
		await expect(
			api.create("/api/v1/namespaces/a/configmaps", {}),
		).rejects.toMatchObject({ code });
	});

	it("maps a transport failure to kube-unavailable and a 404 GET to undefined", async () => {
		const failing = createKubeApi({
			hub: kubeHub(),
			http: async () => {
				throw new Error("ECONNRESET");
			},
			credentials: credentials(),
			now,
		});
		await expect(failing.get("/x")).rejects.toMatchObject({
			code: "kube-unavailable",
		});
		const { http } = transport(404);
		expect(
			await createKubeApi({
				hub: kubeHub(),
				http,
				credentials: credentials(),
				now,
			}).get("/x"),
		).toBeUndefined();
	});

	it("refuses a non-JSON body as kube-response-invalid", async () => {
		const { http } = transport(200, "<html>proxy login</html>");
		const api = createKubeApi({
			hub: kubeHub(),
			http,
			credentials: credentials(),
			now,
		});
		await expect(api.get("/x")).rejects.toMatchObject({
			code: "kube-response-invalid",
		});
	});

	it("parses newline-delimited watch events and maps an expired resourceVersion to 410", async () => {
		const events = [
			'{"type":"ADDED","object":{"metadata":{"name":"a"}}}',
			'{"type":"BOOKMARK","object":{"metadata":{"resourceVersion":"9"}}}',
			"",
		].join("\n");
		const { http, seen } = transport(200, events);
		const api = createKubeApi({
			hub: kubeHub(),
			http,
			credentials: credentials(),
			now,
		});
		const parsed = await api.watch("/apis/x/v1/things", {
			resourceVersion: "5",
			timeoutSeconds: "50",
		});
		expect(parsed.map((e) => e.type)).toEqual(["ADDED", "BOOKMARK"]);
		expect(seen[0]?.url).toContain("watch=1");
		expect(seen[0]?.timeoutMs).toBe(60_000);
		const gone = transport(
			200,
			'{"type":"ERROR","object":{"kind":"Status","code":410,"message":"too old resource version"}}',
		);
		const api410 = createKubeApi({
			hub: kubeHub(),
			http: gone.http,
			credentials: credentials(),
			now,
		});
		await expect(api410.watch("/x", {})).rejects.toMatchObject({
			code: "kube-conflict",
			status: 410,
		});
		const bad = transport(200, '{"type":"WHAT","object":{}}');
		await expect(
			createKubeApi({
				hub: kubeHub(),
				http: bad.http,
				credentials: credentials(),
				now,
			}).watch("/x", {}),
		).rejects.toMatchObject({ code: "kube-response-invalid" });
	});
});

describe("plan resource → Kubernetes object", () => {
	it("renders manifests and product+spec resources, sorted by resource name, without server fields", () => {
		const resolved = resolvedSet("camp-a", [
			deployment("web", "img@sha256:aaaa"),
			volume("db"),
			{
				name: "cfg",
				productId: "configmap",
				params: { data: { LOG: "info" }, labels: { app: "web" } },
			},
		]);
		const objects = renderObjects(resolved, "default");
		expect(
			objects.map((o) => [
				o.resource,
				o.info.kind,
				o.namespace,
				o.name,
				o.data,
			]),
		).toEqual([
			["cfg", "ConfigMap", "default", "cfg", false],
			["db", "PersistentVolumeClaim", "shop", "db", true],
			["web", "Deployment", "shop", "web", false],
		]);
		expect(objects[0]?.body).toEqual({
			apiVersion: "v1",
			kind: "ConfigMap",
			metadata: { name: "cfg", labels: { app: "web" }, namespace: "default" },
			data: { LOG: "info" },
		});
	});

	it("strips status and server-managed metadata from a manifest", () => {
		const resolved = resolvedSet("camp-a", [
			{
				name: "svc",
				params: {
					manifest: {
						apiVersion: "v1",
						kind: "Service",
						metadata: {
							name: "svc",
							namespace: "shop",
							uid: "u",
							resourceVersion: "1",
						},
						spec: { ports: [] },
						status: { loadBalancer: {} },
					},
				},
			},
		]);
		expect(renderObjects(resolved, "default")[0]?.body).toEqual({
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "svc", namespace: "shop" },
			spec: { ports: [] },
		});
	});

	it.each([
		[
			{
				name: "s",
				params: {
					manifest: {
						apiVersion: "v1",
						kind: "Secret",
						metadata: { name: "s" },
					},
				},
			},
			"kube-secret-refused",
		],
		[
			{
				name: "x",
				params: {
					manifest: {
						apiVersion: "example.com/v1",
						kind: "Widget",
						metadata: { name: "x" },
					},
				},
			},
			"kube-kind-unknown",
		],
		[{ name: "y", params: {} }, "kube-object-unrenderable"],
		[
			{ name: "z", params: { manifest: { kind: "Service" } } },
			"kube-object-unrenderable",
		],
		[
			{ name: "Bad_Name", productId: "service", params: { spec: {} } },
			"kube-name-invalid",
		],
		[
			{
				name: "n",
				productId: "service",
				params: { spec: {}, namespace: "Not_DNS" },
			},
			"kube-name-invalid",
		],
	])("refuses %j with %s", (resource, code) => {
		expect(() =>
			renderObjects(resolvedSet("camp-a", [resource]), "default"),
		).toThrow(expect.objectContaining({ code }));
	});

	it("renders an unknown kind when its plural and scope are declared", () => {
		const resolved = resolvedSet("camp-a", [
			{
				name: "w",
				params: {
					resource: "widgets",
					namespaced: true,
					manifest: {
						apiVersion: "example.com/v1",
						kind: "Widget",
						metadata: { name: "w" },
					},
				},
			},
		]);
		expect(renderObjects(resolved, "apps")[0]?.info).toEqual({
			group: "example.com",
			version: "v1",
			kind: "Widget",
			resource: "widgets",
			namespaced: true,
		});
	});

	it("refuses two plan resources that render to the same object", () => {
		const resolved = resolvedSet("camp-a", [
			deployment("web", "a@sha256:1"),
			{ ...deployment("web", "a@sha256:2"), name: "web2" },
		]);
		expect(() => renderObjects(resolved, "default")).toThrow(
			expect.objectContaining({ code: "kube-object-unrenderable" }),
		);
	});

	it("slugs Camp ids into distinct DNS-1123 labels", () => {
		expect(campSlug("camp-a")).toBe("camp-a");
		const a = campSlug("Store/Paris:01");
		const b = campSlug("store-paris-01");
		expect(a).toMatch(/^store-paris-01-[0-9a-f]{6}$/u);
		expect(b).toBe("store-paris-01");
		expect(campSlug("x".repeat(80)).length).toBeLessThanOrEqual(40);
		expect(campSlug("///")).toMatch(/^c-[0-9a-f]{6}$/u);
	});
});
