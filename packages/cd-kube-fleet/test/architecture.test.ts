// I11 and D26 as architecture tests: no Kubernetes type crosses into
// @hobo/cd; this package speaks Kubernetes over HttpTransport with no client
// library; and it never uses a fleet manager's own rollout, placement,
// override or failover machinery.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const cdRoot = resolve(packageRoot, "../cd");

function files(root: string, skip: (path: string) => boolean = () => false): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		if (skip(path)) continue;
		if (statSync(path).isDirectory()) out.push(...files(path, skip));
		else if (path.endsWith(".ts")) out.push(path);
	}
	return out.sort();
}

// Kubernetes fleet vocabulary that must stay inside this adapter package.
const KUBE_TYPES =
	/\b(ManifestWork|ManifestWorkReplicaSet|PropagationPolicy|ClusterPropagationPolicy|OverridePolicy|ResourceBinding|ClusterProfile|ManagedCluster|AddOnPlacementScore)\b|open-cluster-management\.io|karmada\.io|multicluster\.x-k8s\.io|cd-kube-fleet/u;

// REST resources whose use would hand scheduling, rollout, override or
// failover to the fleet manager (D26).
const FORBIDDEN_RESOURCES =
	/"[^"\n]*\b(manifestworkreplicasets|placements|placementdecisions|addonplacementscores|overridepolicies|clusteroverridepolicies|clusterpropagationpolicies|workloadrebalancers)\b[^"\n]*"|`[^`\n]*\b(manifestworkreplicasets|placements|placementdecisions|overridepolicies|clusteroverridepolicies)\b[^`\n]*`/u;

describe("I11 neutral core and D26 transport-only", () => {
	it("No Kubernetes type crosses into @hobo/cd (I11 scan)", () => {
		const scanned = files(join(cdRoot, "src"), (path) => {
			const rel = relative(join(cdRoot, "src"), path);
			return rel.startsWith("adapters") || rel.startsWith(join("verification", "sources")) || rel.startsWith("_generated");
		});
		expect(scanned.length).toBeGreaterThan(0);
		const offenders = scanned.filter((path) => KUBE_TYPES.test(readFileSync(path, "utf8"))).map((path) => relative(cdRoot, path));
		expect(offenders).toEqual([]);
		const proto = readFileSync(join(cdRoot, "data-models/cd.proto"), "utf8");
		expect(KUBE_TYPES.test(proto)).toBe(false);
	});

	it("@hobo/cd does not depend on this adapter; this adapter depends on @hobo/cd and @hobo/core only", () => {
		// SAFETY: package manifests are JSON objects.
		const cd = JSON.parse(readFileSync(join(cdRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
		expect(Object.keys(cd.dependencies ?? {})).not.toContain("@hobo/cd-kube-fleet");
		// SAFETY: package manifests are JSON objects.
		const own = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		expect(Object.keys(own.dependencies ?? {}).sort()).toEqual(["@bufbuild/protobuf", "@hobo/cd", "@hobo/core"]);
		expect(own.devDependencies).toBeUndefined();
	});

	it("speaks the Kubernetes API over HttpTransport only: no client library, no fetch, no kubeconfig", () => {
		for (const path of files(join(packageRoot, "src"))) {
			const source = readFileSync(path, "utf8");
			expect(source, relative(packageRoot, path)).not.toMatch(/@kubernetes\/client-node|kubernetes-client|\bfetch\(|KUBECONFIG|process\.env|node:https?"/u);
			expect(source, relative(packageRoot, path)).not.toMatch(/from "@hobo\/(?!cd"|core")/u);
		}
	});

	it("never addresses a fleet manager's rollout, placement, override or failover resources (D26)", () => {
		for (const path of files(join(packageRoot, "src"))) {
			expect(FORBIDDEN_RESOURCES.test(readFileSync(path, "utf8")), relative(packageRoot, path)).toBe(false);
		}
	});

	it("exports only realizers, the inventory, parsers, records and error/metric vocabularies", async () => {
		const surface = Object.keys(await import("../src/index.js")).sort();
		expect(surface).toEqual(
			[
				"CampClusterRecordSchema",
				"ClusterProfileImportRecordSchema",
				"HubKind",
				"ImportedClusterRecordSchema",
				"KNOWN_KINDS",
				"KUBE_FLEET_DEFAULTS",
				"KUBE_FLEET_FAILURES",
				"KUBE_FLEET_METRICS",
				"KUBE_FLEET_SCHEMAS",
				"KarmadaRealizerRecordSchema",
				"KubeAuth",
				"KubeFleetError",
				"KubeHubRecordSchema",
				"KubeObjectRefRecordSchema",
				"OcmRealizerRecordSchema",
				"clusterProfileInventory",
				"karmadaRealizer",
				"ocmRealizer",
				"parseClusterProfileImport",
				"parseKarmadaRealizerConfig",
				"parseKubeHub",
				"parseOcmRealizerConfig",
			].sort(),
		);
	});
});
