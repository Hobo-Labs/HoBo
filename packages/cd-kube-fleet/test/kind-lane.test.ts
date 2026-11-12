// Live lane (plan 0024 R16): the realizers against real hubs running in
// `kind`. Gated on availability; every skip names what is missing. Set up
// with the runbook in README.md ("Live kind lane"):
//   HOBO_KIND_OCM_API, HOBO_KIND_OCM_TOKEN, HOBO_KIND_OCM_CLUSTER
//   HOBO_KIND_KARMADA_API, HOBO_KIND_KARMADA_TOKEN, HOBO_KIND_KARMADA_MEMBER
// and NODE_EXTRA_CA_CERTS pointing at the kind clusters' CA bundle.
import { createBoundedFetchTransport, guardTransport, type HttpTransport } from "@hobo/core";
import { type Realizer, ReconcileStatus } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import { karmadaRealizer, ocmRealizer, parseKarmadaRealizerConfig, parseOcmRealizerConfig } from "../src/index.js";
import { ctx, deployment, realizeInput } from "./fixtures.js";

type Lane = Readonly<{ api: string; token: string; cluster: string }>;

function lane(prefix: string): Lane | string {
	const api = process.env[`${prefix}_API`];
	const token = process.env[`${prefix}_TOKEN`];
	const cluster = process.env[`${prefix}_CLUSTER`] ?? process.env[`${prefix}_MEMBER`];
	const missing = [
		api === undefined ? `${prefix}_API` : undefined,
		token === undefined ? `${prefix}_TOKEN` : undefined,
		cluster === undefined ? `${prefix}_CLUSTER|MEMBER` : undefined,
	].filter((m) => m !== undefined);
	if (missing.length > 0 || api === undefined || token === undefined || cluster === undefined)
		return `kind hub not available: set ${missing.join(", ")}`;
	return { api, token, cluster };
}

function transport(api: string): HttpTransport {
	const url = new URL(api);
	return guardTransport(createBoundedFetchTransport({ fetchImpl: globalThis.fetch }), {
		allowedHosts: [url.hostname],
		allowedPathPrefixes: ["/api", "/apis"],
		allowedPorts: [url.port === "" ? "443" : url.port],
		maxTimeoutMs: 120_000,
		maxResponseBytes: 16_777_216,
	});
}

async function untilConverged(realizer: Realizer, campId: string): Promise<ReconcileStatus> {
	const resources = [deployment("hobo-kind-web", "registry.k8s.io/pause@sha256:7031c1b283388d2c2e09b57badb803c05ebed362dc88d84b480cc47f72a21097", 1, "default")];
	let status = ReconcileStatus.CONVERGING;
	for (let attempt = 0; attempt < 60 && status !== ReconcileStatus.CONVERGED; attempt += 1) {
		status = (await realizer.converge(realizeInput(campId, resources), { ...ctx, now: Date.now })).status;
		if (status === ReconcileStatus.BLOCKED) return status;
		if (status !== ReconcileStatus.CONVERGED) await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	return status;
}

const ocm = lane("HOBO_KIND_OCM");
describe.skipIf(typeof ocm === "string")(`kind lane: OCM hub${typeof ocm === "string" ? ` (skipped: ${ocm})` : ""}`, () => {
	it("converges one ManifestWork on a kind-backed ManagedCluster", { timeout: 180_000 }, async () => {
		if (typeof ocm === "string") return;
		const realizer = ocmRealizer({
			config: parseOcmRealizerConfig({
				schemaVersion: "hobo.cd-kube-fleet.ocm/v1",
				hub: { schemaVersion: "hobo.cd-kube-fleet.hub/v1", name: "kind-ocm", kind: "HUB_KIND_OCM", apiBaseUrl: ocm.api, credentialRef: "env:kind-ocm", auth: "KUBE_AUTH_BEARER" },
				clusters: [{ campId: "kind-camp", cluster: ocm.cluster }],
			}),
			http: transport(ocm.api),
			credentials: { resolve: async () => ({ token: ocm.token }) },
		});
		expect(await untilConverged(realizer, "kind-camp")).toBe(ReconcileStatus.CONVERGED);
	});
});

const karmada = lane("HOBO_KIND_KARMADA");
describe.skipIf(typeof karmada === "string")(`kind lane: Karmada${typeof karmada === "string" ? ` (skipped: ${karmada})` : ""}`, () => {
	it("converges a template pinned to one kind member", { timeout: 180_000 }, async () => {
		if (typeof karmada === "string") return;
		const realizer = karmadaRealizer({
			config: parseKarmadaRealizerConfig({
				schemaVersion: "hobo.cd-kube-fleet.karmada/v1",
				hub: { schemaVersion: "hobo.cd-kube-fleet.hub/v1", name: "kind-karmada", kind: "HUB_KIND_KARMADA", apiBaseUrl: karmada.api, credentialRef: "env:kind-karmada", auth: "KUBE_AUTH_BEARER" },
				clusters: [{ campId: "kind-camp", cluster: karmada.cluster }],
			}),
			http: transport(karmada.api),
			credentials: { resolve: async () => ({ token: karmada.token }) },
		});
		expect(await untilConverged(realizer, "kind-camp")).toBe(ReconcileStatus.CONVERGED);
	});
});
