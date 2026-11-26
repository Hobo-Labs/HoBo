import { describe, expect, it } from "vitest";
import {
	createKubernetesProvider,
	kubernetesNativePorts,
	supportsAnonymousTemporaryDeploy,
} from "../src/index.js";
import { provisionTemporaryEnvironmentStation } from "../src/temporary-station.js";
import {
	assertAllowedEndpoint,
	DEFAULT_TRANSPORT_POLICY,
} from "../src/transport.js";

describe("apiserver path guard", () => {
	it("refuses an encoded separator that survives URL parsing", () => {
		// The literal `/..` check next to this one never saw these: WHATWG
		// resolves dot segments while parsing and treats `%2e` as a dot, but
		// `%2f` and `%5c` are not separators to it. They keep the `/api/v1/`
		// prefix intact, pass the prefix check, and are decoded only by the
		// apiserver — which is exactly how a namespaced call reaches a
		// cluster-scoped object.
		for (const url of [
			"https://k8s.example/api/v1/namespaces/%2f%2e%2e%2fnodes",
			"https://k8s.example/api/v1/namespaces/..%5cnodes",
		]) {
			expect(() =>
				assertAllowedEndpoint(url, DEFAULT_TRANSPORT_POLICY),
			).toThrow(/percent-encodes/u);
		}

		expect(
			assertAllowedEndpoint(
				"https://k8s.example/api/v1/namespaces/default/pods",
				DEFAULT_TRANSPORT_POLICY,
			).pathname,
		).toBe("/api/v1/namespaces/default/pods");
	});
});

describe("@hobo/provider-kubernetes", () => {
	it("exposes Matching-honest native ports", () => {
		const provider = createKubernetesProvider();
		expect(kubernetesNativePorts().length).toBeGreaterThan(0);
		expect(provider.capabilities.length).toBe(kubernetesNativePorts().length);
		const compute = provider.capabilities.find((c) => c.port === "compute");
		expect(compute?.satisfies({ port: "compute" }).kind).toBe("full");
	});

	it("temporary deploy support flag is honest", () => {
		expect(supportsAnonymousTemporaryDeploy).toBe(true);
	});

	it("temporary provision path", async () => {
		const result = await provisionTemporaryEnvironmentStation({
			stationId: "st-1",
		});
		expect(result.anonymous).toBe(true);
		expect(result.temporary).toBe(true);
		expect(result.providerId).toBe("kubernetes");
		expect(result.claimUrl.length).toBeGreaterThan(0);
	});
});
