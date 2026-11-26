import assert from "node:assert/strict";
// Cross-adapter composition proof, homed in the composition root: the package
// boundary guard forbids adapter -> adapter imports, so this test lives in
// @hobo/hobo (which legally depends on both @hobo/iac-pulumi and
// @hobo/provider-cloudflare) to prove realize() output is accepted by the
// real IaC backend.
import {
	createPulumiAutomationAdapter,
	runIacBackendConformance,
	validateIacProgram,
} from "@hobo/iac-pulumi";
import {
	createCloudflareProvider,
	createHelloBindlePlan,
	type ResourcePlan,
	realizeHelloBindle,
} from "@hobo/provider-cloudflare";
import { describe, it } from "vitest";

const PORTS: Array<{ port: string; name: string }> = [
	{ port: "compute", name: "web" },
	{ port: "kv", name: "sessions" },
	{ port: "objectStore", name: "assets" },
];

describe("realize() output composes with @hobo/iac-pulumi.validateIacProgram", () => {
	for (const { port, name } of PORTS) {
		it(`iac-pulumi accepts the realized ${port} program`, () => {
			const provider = createCloudflareProvider();
			const plan: ResourcePlan = { name, port, provider: "cloudflare" };
			const { iac } = provider.realize(plan);
			assert.doesNotThrow(() => validateIacProgram(iac));
		});
	}

	it("iac-pulumi accepts the whole hello-bindle program", () => {
		const { iac } = realizeHelloBindle(createHelloBindlePlan());
		assert.doesNotThrow(() => validateIacProgram(iac));
	});
});

describe("realized programs are previewable / applyable end-to-end", () => {
	it("passes the iac-pulumi backend conformance suite for a single-port program", async () => {
		const provider = createCloudflareProvider();
		const { iac } = provider.realize({
			name: "assets",
			port: "objectStore",
			provider: "cloudflare",
		});
		const adapter = createPulumiAutomationAdapter();
		const report = await runIacBackendConformance({ adapter, program: iac });
		assert.equal(report.passed, true);
	});

	it("previews the hello-bindle program to a dirty diff", async () => {
		const { iac } = realizeHelloBindle(createHelloBindlePlan());
		const adapter = createPulumiAutomationAdapter();
		const preview = await adapter.preview(iac);
		assert.equal(preview.kind, "diff");
		assert.equal(preview.dirty, true);
		assert.equal(preview.changes.length, 3);
	});
});
