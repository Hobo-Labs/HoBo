// Parse boundary (src/config.ts) and data-models/kube_fleet.cue agree: a
// record the parser accepts vets clean, and one it refuses, CUE refuses.
import { DepartureAction } from "@hobo/cd";
import type { JsonObject, JsonValue } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	HubKind,
	KubeAuth,
	parseClusterProfileImport,
	parseKarmadaRealizerConfig,
	parseOcmRealizerConfig,
} from "../src/index.js";
import { cue, vets } from "./cue-support.js";
import { hub } from "./fixtures.js";

const ocm = (
	patch: JsonObject = {},
	hubPatch: JsonObject = {},
): JsonObject => ({
	schemaVersion: "hobo.cd-kube-fleet.ocm/v1",
	hub: { ...hub("HUB_KIND_OCM"), ...hubPatch },
	clusters: [{ campId: "camp-a", cluster: "cluster-a" }],
	...patch,
});

const profiles = (patch: JsonObject = {}): JsonObject => ({
	schemaVersion: "hobo.cd-kube-fleet.cluster-profiles/v1",
	hub: hub("HUB_KIND_CLUSTER_INVENTORY"),
	yardId: "yard-eu",
	stationId: "station-eu",
	provider: "kubernetes",
	envType: "prod",
	regions: ["eu-west-1"],
	...patch,
});

type Parsed =
	| ReturnType<typeof parseOcmRealizerConfig>
	| ReturnType<typeof parseKarmadaRealizerConfig>
	| ReturnType<typeof parseClusterProfileImport>;
type Case = Readonly<[string, string, JsonObject, (v: JsonValue) => Parsed]>;

const ACCEPTED: readonly Case[] = [
	[
		"a minimal OCM realizer",
		"#OcmRealizerRecord",
		ocm(),
		parseOcmRealizerConfig,
	],
	[
		"an OCM realizer with DELETE departure and exec auth",
		"#OcmRealizerRecord",
		ocm(
			{ departureAction: "DEPARTURE_ACTION_DELETE" },
			{ auth: "KUBE_AUTH_EXEC", timeoutMs: 30000 },
		),
		parseOcmRealizerConfig,
	],
	[
		"a Karmada realizer",
		"#KarmadaRealizerRecord",
		{
			...ocm(
				{ schemaVersion: "hobo.cd-kube-fleet.karmada/v1" },
				{ kind: "HUB_KIND_KARMADA" },
			),
		},
		parseKarmadaRealizerConfig,
	],
	[
		"a ClusterProfile import",
		"#ClusterProfileImportRecord",
		profiles({
			namespace: "fleet-system",
			campIdPrefix: "k8s-",
			labelSelector: { env: "prod" },
			watchTimeoutSeconds: 120,
		}),
		parseClusterProfileImport,
	],
];

const REFUSED: readonly Case[] = [
	[
		"an http API URL",
		"#OcmRealizerRecord",
		ocm({}, { apiBaseUrl: "http://hub.example" }),
		parseOcmRealizerConfig,
	],
	[
		"an API URL with a path",
		"#OcmRealizerRecord",
		ocm({}, { apiBaseUrl: "https://hub.example/api" }),
		parseOcmRealizerConfig,
	],
	[
		"an API URL with credentials",
		"#OcmRealizerRecord",
		ocm({}, { apiBaseUrl: "https://user:pw@hub.example" }),
		parseOcmRealizerConfig,
	],
	[
		"an empty credential reference",
		"#OcmRealizerRecord",
		ocm({}, { credentialRef: "" }),
		parseOcmRealizerConfig,
	],
	[
		"a Karmada hub under an OCM realizer",
		"#OcmRealizerRecord",
		ocm({}, { kind: "HUB_KIND_KARMADA" }),
		parseOcmRealizerConfig,
	],
	[
		"a non-DNS cluster name",
		"#OcmRealizerRecord",
		ocm({ clusters: [{ campId: "camp-a", cluster: "Cluster_A" }] }),
		parseOcmRealizerConfig,
	],
	[
		"no clusters",
		"#OcmRealizerRecord",
		ocm({ clusters: [] }),
		parseOcmRealizerConfig,
	],
	[
		"an unknown departure action",
		"#OcmRealizerRecord",
		ocm({ departureAction: "DEPARTURE_ACTION_SHRED" }),
		parseOcmRealizerConfig,
	],
	[
		"a wrong schema version",
		"#OcmRealizerRecord",
		ocm({ schemaVersion: "hobo.cd-kube-fleet.ocm/v2" }),
		parseOcmRealizerConfig,
	],
	[
		"a too-short timeout",
		"#OcmRealizerRecord",
		ocm({}, { timeoutMs: 10 }),
		parseOcmRealizerConfig,
	],
	[
		"an import with no regions",
		"#ClusterProfileImportRecord",
		profiles({ regions: [] }),
		parseClusterProfileImport,
	],
	[
		"an import with a bad namespace",
		"#ClusterProfileImportRecord",
		profiles({ namespace: "Fleet" }),
		parseClusterProfileImport,
	],
	[
		"an import with a bad camp prefix",
		"#ClusterProfileImportRecord",
		profiles({ campIdPrefix: "K8S/" }),
		parseClusterProfileImport,
	],
	[
		"an import with a bad label selector",
		"#ClusterProfileImportRecord",
		profiles({ labelSelector: { "bad key!": "x" } }),
		parseClusterProfileImport,
	],
	[
		"an import with a too-long watch",
		"#ClusterProfileImportRecord",
		profiles({ watchTimeoutSeconds: 3600 }),
		parseClusterProfileImport,
	],
];

describe("configuration parse boundary", () => {
	it.each(ACCEPTED)("accepts %s", (_name, _def, value, parse) => {
		expect(() => parse(value)).not.toThrow();
	});

	it.each(
		REFUSED,
	)("refuses %s with kube-fleet-config-invalid", (_name, _def, value, parse) => {
		expect(() => parse(value)).toThrow(
			expect.objectContaining({ code: "kube-fleet-config-invalid" }),
		);
	});

	it("defaults departure to ORPHAN_DATA, auth to bearer and the timeout to 15 s", () => {
		const config = parseOcmRealizerConfig(ocm());
		expect(config.departureAction).toBe(DepartureAction.ORPHAN_DATA);
		expect(config.hub.auth).toBe(KubeAuth.BEARER);
		expect(config.hub.kind).toBe(HubKind.OCM);
		expect(config.hub.timeoutMs).toBe(15_000);
		expect(config.clusters.get("camp-a")).toBe("cluster-a");
		expect(Object.isFrozen(config)).toBe(true);
	});

	it("refuses a Camp mapped twice", () => {
		expect(() =>
			parseOcmRealizerConfig(
				ocm({
					clusters: [
						{ campId: "a", cluster: "x" },
						{ campId: "a", cluster: "y" },
					],
				}),
			),
		).toThrow(expect.objectContaining({ code: "kube-fleet-config-invalid" }));
	});

	it("declares import regions, sorted and de-duplicated, and the 50 s watch default", () => {
		const parsed = parseClusterProfileImport(
			profiles({ regions: ["eu-west-3", "eu-west-1", "eu-west-1"] }),
		);
		expect(parsed.regions).toEqual(["eu-west-1", "eu-west-3"]);
		expect(parsed.watchTimeoutSeconds).toBe(50);
		expect(parsed.namespace).toBeUndefined();
	});
});

describe.skipIf(cue === undefined)(
	"kube_fleet.cue agrees with the parse boundary (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it.each(ACCEPTED)("CUE accepts %s", (_name, definition, value) => {
			expect(vets(definition, value)).toBe(true);
		});
		it.each(REFUSED)("CUE refuses %s", (_name, definition, value) => {
			expect(vets(definition, value)).toBe(false);
		});
		it("CUE constrains the imported record and object references", () => {
			expect(
				vets("#ImportedClusterRecord", {
					campId: "k8s-fleet-a",
					profileNamespace: "fleet",
					profileName: "a",
					accessProviders: ["p"],
				}),
			).toBe(true);
			expect(
				vets("#ImportedClusterRecord", {
					campId: "",
					profileNamespace: "fleet",
					profileName: "a",
				}),
			).toBe(false);
			expect(
				vets("#KubeObjectRefRecord", {
					group: "apps",
					version: "v1",
					kind: "Deployment",
					resource: "deployments",
					namespace: "shop",
					name: "web",
				}),
			).toBe(true);
			expect(
				vets("#KubeObjectRefRecord", {
					version: "1",
					kind: "deployment",
					resource: "Deployments",
					name: "web",
				}),
			).toBe(false);
			expect(
				vets("#CampClusterRecord", { campId: "camp-a", cluster: "cluster-a" }),
			).toBe(true);
		});
	},
);
