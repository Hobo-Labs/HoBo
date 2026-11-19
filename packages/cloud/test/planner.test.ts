import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromJson } from "@bufbuild/protobuf";
import { type ManifestV1, parseManifest } from "@hobo/bindles";
import {
	createCloudflareProvider,
	realizeResourcePlans,
} from "@hobo/provider-cloudflare";
import { describe, expect, it } from "vitest";
import {
	canonicalPlanJson,
	createRegistryFromProviders,
	hashDeploymentPlan,
	plan,
} from "../src/index.js";
import { MatchDecidedSchema } from "../src/_generated/cloud_pb.js";
import { type JsonValue, parseJsonValue } from "../src/json.js";

const HELLO_BINDLE_PLAN_HASH =
	"sha256:0e1bbf78ae6b765d8a4cd5cb41c5b9c5eadc43e32ea4fedec97cf87a7deef915";

function fixture(name: string): JsonValue {
	return parseJsonValue(
		readFileSync(
			fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
			"utf8",
		),
	);
}

function helloBindle(): ManifestV1 {
	return parseManifest(fixture("hello-bindle.manifest.json"));
}

function registry() {
	return createRegistryFromProviders([createCloudflareProvider()]);
}

function checkCue(schema: string, json: string) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-planner-contract-"));
	try {
		const input = join(directory, "record.json");
		writeFileSync(input, json);
		const cue =
			process.env.HOBO_CUE_BIN ??
			fileURLToPath(
				new URL(
					`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
					import.meta.url,
				),
			);
		const checked = spawnSync(
			cue,
			[
				"vet",
				"-d",
				schema,
				fileURLToPath(new URL("../data-models/cloud.cue", import.meta.url)),
				input,
			],
			{ encoding: "utf8" },
		);
		if (checked.error) throw checked.error;
		return checked;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("Planner: hello-bindle golden DeploymentPlan DAG", () => {
	it("provisions a linked resource before its consumer", () => {
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: {
				"a-api": {
					type: "component.v1",
					image: "oci://example/api",
					runtime: "wasm",
					exports: ["wasi:http/incoming-handler"],
					links: [{ import: "kv", to: "z-cache" }],
				},
				"z-cache": { type: "data.v1", port: "kv" },
			},
		});
		const result = plan(manifest, { deploymentId: "linked" }, registry());
		if (!result.ok) throw new Error(result.reason);
		expect(result.plan.dependencyOrder).toEqual(["z-cache", "a-api"]);
		expect(
			result.plan.resources.find((resource) => resource.name === "a-api")?.deps,
		).toEqual(["z-cache"]);
	});

	it("deduplicates dependencies named by both links and binds", () => {
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: {
				api: {
					type: "component.v1",
					image: "oci://example/api",
					runtime: "wasm",
					exports: ["wasi:http/incoming-handler"],
					links: [{ import: "kv", to: "cache" }],
					bind: ["cache"],
				},
				cache: { type: "data.v1", port: "kv" },
			},
		});
		const result = plan(manifest, { deploymentId: "duplicate" }, registry());
		if (!result.ok) throw new Error(result.reason);
		expect(
			result.plan.resources.find((resource) => resource.name === "api")?.deps,
		).toEqual(["cache"]);
		expect(result.plan.dependencyOrder).toEqual(["cache", "api"]);
	});

	it("rejects cycles that include a linked resource", () => {
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: {
				api: {
					type: "component.v1",
					image: "oci://example/api",
					runtime: "wasm",
					exports: ["wasi:http/incoming-handler"],
					links: [{ import: "kv", to: "cache" }],
				},
				cache: { type: "data.v1", port: "kv", bind: ["api"] },
			},
		});
		const result = plan(manifest, { deploymentId: "linked-cycle" }, registry());
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.remediations[0]?.code).toBe("dependency.cycle");
	});

	it("refuses cyclic dependencies instead of inventing a provisioning order", () => {
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: {
				one: {
					type: "component.v1",
					image: "oci://example/one",
					runtime: "wasm",
					exports: ["wasi:http/incoming-handler"],
					bind: ["two"],
				},
				two: {
					type: "component.v1",
					image: "oci://example/two",
					runtime: "wasm",
					exports: ["wasi:http/incoming-handler"],
					bind: ["one"],
				},
			},
		});
		const result = plan(manifest, { deploymentId: "cycle" }, registry());
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.remediations[0]?.code).toBe("dependency.cycle");
	});
	it("produces the byte-stable golden plan with the recorded content hash", () => {
		const result = plan(
			helloBindle(),
			{ deploymentId: "hello-bindle-001" },
			registry(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(parseJsonValue(canonicalPlanJson(result.plan))).toEqual(
			fixture("golden-plan.json"),
		);
		expect(result.planHash).toBe(HELLO_BINDLE_PLAN_HASH);
		expect(hashDeploymentPlan(result.plan)).toBe(HELLO_BINDLE_PLAN_HASH);
	});

	it("is deterministic: two independent runs are byte-identical", () => {
		const a = plan(helloBindle(), { deploymentId: "x" }, registry());
		const b = plan(helloBindle(), { deploymentId: "y" }, registry());
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(canonicalPlanJson(a.plan)).toBe(canonicalPlanJson(b.plan));
		expect(a.planHash).toBe(b.planHash);
	});

	it("records a match.Decided decision per resource with catalog provenance", () => {
		const reg = registry();
		const result = plan(helloBindle(), { deploymentId: "hb-1" }, reg);
		if (!result.ok) throw new Error("expected plan to succeed");

		expect(result.decisions.map((d) => d.resource).sort()).toEqual([
			"assets",
			"service",
			"sessions",
		]);
		for (const decision of result.decisions) {
			expect(decision.providerId).toBe("@hobo/provider-cloudflare");
			expect(decision.deploymentId).toBe("hb-1");
			expect(decision.winner).toBe(
				`@hobo/provider-cloudflare.${decision.port}`,
			);
			expect(decision.ranking[0]?.providerId).toBe("@hobo/provider-cloudflare");
			for (const rejectedCandidate of decision.rejectedCandidates) {
				expect(rejectedCandidate.reason.length).toBeGreaterThan(0);
			}
			expect(decision.tie === true || decision.tie === false).toBe(true);
			expect(decision.catalogContentHash).toBe(reg.catalogHash);
		}
	});

	it("accepts emitted match decisions in the CUE and protobuf contracts", () => {
		const base = registry();
		const compute = base
			.definitions()
			.find((definition) => definition.port === "compute");
		if (!compute) throw new Error("missing compute definition");
		const competing = { ...compute, id: `${compute.id}-alternative` };
		const result = plan(
			helloBindle(),
			{ deploymentId: "contract" },
			{
				...base,
				definitions: () => [...base.definitions(), competing],
			},
		);
		if (!result.ok) throw new Error(result.reason);
		const decision = result.decisions.find(
			(entry) => entry.rejectedCandidates.length > 0,
		);
		if (!decision) throw new Error("missing competing candidate");
		const json = JSON.stringify(decision);
		const record = fromJson(MatchDecidedSchema, parseJsonValue(json));
		expect(
			record.rejectedCandidates.map((entry) => entry.definitionId),
		).toEqual(decision.rejectedCandidates.map((entry) => entry.definitionId));
		expect(record.catalogContentHash).toBe(decision.catalogContentHash);
		const checked = checkCue("#MatchDecided", json);
		expect(checked.status, checked.stderr).toBe(0);
	});

	it("realizes the golden plan into a previewable Cloudflare Pulumi program", () => {
		const result = plan(helloBindle(), { deploymentId: "hb-1" }, registry());
		if (!result.ok) throw new Error("expected plan to succeed");
		const { iac } = realizeResourcePlans(result.plan.resources, {
			deploymentId: "hb-1",
		});
		expect(iac.resources.map((r) => r.name).sort()).toEqual([
			"assets",
			"service",
			"sessions",
		]);
		expect(iac.resources.map((r) => r.type).sort()).toEqual([
			"cloudflare:kv-namespace",
			"cloudflare:r2-bucket",
			"cloudflare:workers-script",
		]);
	});
});

describe("Planner: unsatisfiable resource -> deployment.PlanRejected", () => {
	it("rejects with a machine-readable, remediation-bearing reason", () => {
		const manifest = parseManifest(fixture("unsatisfiable.manifest.json"));
		const result = plan(manifest, { deploymentId: "reject-1" }, registry());

		expect(result.ok).toBe(false);
		if (result.ok) return;

		expect(result.deploymentId).toBe("reject-1");
		expect(result.remediations).toHaveLength(1);
		const remediation = result.remediations[0];
		expect(remediation.resource).toBe("ledger");
		expect(remediation.code).toBe("capability.port-unavailable");
		expect(remediation.requiredPort).toBe("database");
		expect(remediation.suggestedProvider).toBeUndefined();
		expect(remediation.remediation).toContain("register a provider");
		const body = {
			deploymentId: result.deploymentId,
			reason: result.reason,
			remediations: result.remediations,
		};
		const checked = checkCue("#DeploymentPlanRejected", JSON.stringify(body));
		expect(checked.status, checked.stderr).toBe(0);
		const empty = checkCue(
			"#DeploymentPlanRejected",
			JSON.stringify({ ...body, remediations: [] }),
		);
		expect(empty.status).toBe(1);
	});
});
