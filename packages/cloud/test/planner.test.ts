import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ManifestV1, parseManifest } from "@hobo/bindles";
import {
	createCloudflareProvider,
	realizeResourcePlans,
} from "@hobo/provider-cloudflare";
import { describe, expect, it } from "vitest";
import {
	canonicalPlanJson,
	createRegistryFromProviders,
	type DeploymentPlan,
	hashDeploymentPlan,
	plan,
} from "../src/index.js";
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

describe("Planner: hello-bindle golden DeploymentPlan DAG", () => {
	it("produces the byte-stable golden plan with the recorded content hash", () => {
		const result = plan(
			helloBindle(),
			{ deploymentId: "hello-bindle-001" },
			registry(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// SAFETY: `const golden = fixture("golden-plan.json") as DeploymentPlan;` is required at this I/O or test boundary.
		const golden = fixture("golden-plan.json") as DeploymentPlan;
		expect(JSON.parse(canonicalPlanJson(result.plan))).toEqual(
			JSON.parse(canonicalPlanJson(golden)),
		);
		expect(result.planHash).toBe(HELLO_BINDLE_PLAN_HASH);
		// The hash is over the canonical form, so the committed fixture re-hashes equal.
		expect(hashDeploymentPlan(golden)).toBe(HELLO_BINDLE_PLAN_HASH);
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
			expect(decision.catalogHash).toBe(reg.catalogHash);
			expect(decision.winner).toBe(
				`@hobo/provider-cloudflare.${decision.port}`,
			);
			// Canonical shape (ADR-0033/0088): ranking (winner first), structured
			// rejections mirroring the deprecated flat list, tie flag, and the
			// catalog content-hash alias staying in lockstep.
			expect(decision.ranking[0]?.providerId).toBe("@hobo/provider-cloudflare");
			expect(decision.rejectedCandidates.map((r) => r.definitionId)).toEqual(
				decision.rejected,
			);
			for (const rejectedCandidate of decision.rejectedCandidates) {
				expect(rejectedCandidate.reason.length).toBeGreaterThan(0);
			}
			expect(decision.tie === true || decision.tie === false).toBe(true);
			expect(decision.catalogContentHash).toBe(reg.catalogHash);
		}
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
	});
});
