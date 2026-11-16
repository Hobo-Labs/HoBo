import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	assertLocalIacProgram,
	cloudflare,
	createCloudflareProvider,
	createHelloBindlePlan,
	type ResourcePlan,
	realizeHelloBindle,
	realizeResourcePlan,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

// Golden per-port ResourcePlans -> expected Cloudflare resource class.
const GOLDEN: Array<{ port: string; name: string; resourceClass: string }> = [
	{ port: "compute", name: "web", resourceClass: "cloudflare:workers-script" },
	{ port: "kv", name: "sessions", resourceClass: "cloudflare:kv-namespace" },
	{
		port: "objectStore",
		name: "assets",
		resourceClass: "cloudflare:r2-bucket",
	},
];

describe("realize() emits a valid IacProgram per initial port", () => {
	for (const golden of GOLDEN) {
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		it(`realizes ${golden.port} -> ${golden.resourceClass} as a valid program`, () => {
			const provider = createCloudflareProvider();
			const plan: ResourcePlan = {
				name: golden.name,
				port: golden.port,
				provider: "cloudflare",
			};
			const { iac } = provider.realize(plan);

			// LOCAL copy of the iac-pulumi shape accepts it (see also the real
			// @hobo/iac-pulumi composition test).
			assert.doesNotThrow(() => assertLocalIacProgram(iac));
			assert.equal(iac.apiVersion, "hobo.iac-program/v1");
			assert.equal(iac.kind, "iac-program");
			assert.equal(iac.provider, "pulumi");
			assert.equal(iac.resources.length, 1);
			assert.equal(iac.resources[0]?.name, golden.name);
			assert.equal(iac.resources[0]?.type, golden.resourceClass);
			assert.equal(iac.resources[0]?.provider, "cloudflare");
		});
	}
});

describe("realize() option negotiation", () => {
	it("drops foreign provider option blocks, keeping only Cloudflare options", () => {
		const plan: ResourcePlan = {
			name: "web",
			port: "compute",
			provider: "cloudflare",
			options: [
				cloudflare.with.worker({ cpuMs: 15_000 }),
				{
					providerId: "aws",
					port: "compute",
					optionName: "fargate",
					negotiation: "prefer",
					options: { cpu: 2 },
				},
			],
		};
		const { iac } = realizeResourcePlan(plan);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const options = iac.resources[0]?.inputs.options as JsonObject;
		assert.equal(options.cpuMs, 15_000);
		assert.equal("cpu" in options, false);
	});

	it("emits a BuildSpec when the plan carries a build artifact", () => {
		const plan: ResourcePlan = {
			name: "web",
			port: "compute",
			provider: "cloudflare",
			build: {
				artifactId: "hello-bindle-wasm",
				source: "examples/hello-bindle",
				target: "wasm-component",
			},
		};
		const emission = realizeResourcePlan(plan);
		assert.equal(emission.build?.artifacts[0]?.id, "hello-bindle-wasm");
	});
});

describe("hello-bindle realizes end-to-end", () => {
	it("emits one multi-resource IacProgram with resolved bind references", () => {
		const { iac, build } = realizeHelloBindle(createHelloBindlePlan());

		assert.doesNotThrow(() => assertLocalIacProgram(iac));
		assert.deepEqual(
			iac.resources.map((resource) => [resource.name, resource.type]),
			[
				["service", "cloudflare:workers-script"],
				["assets", "cloudflare:r2-bucket"],
				["sessions", "cloudflare:kv-namespace"],
			],
		);
		// Worker binds to assets + sessions via ${resources.*.outputs.binding}.
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const bindings = iac.resources[0]?.inputs.bindings as Array<{
			ref: string;
		}>;
		assert.deepEqual(
			bindings.map((bind) => bind.ref),
			[
				// Not template literals: these are the literal output-reference strings
				// the IaC program emits (`resources.<name>.outputs.<output>`), which is
				// exactly what this assertion pins.
				// biome-ignore-start lint/suspicious/noTemplateCurlyInString: literal IaC output refs
				"${resources.assets.outputs.binding}",
				"${resources.sessions.outputs.binding}",
				// biome-ignore-end lint/suspicious/noTemplateCurlyInString: literal IaC output refs
			],
		);
		assert.equal(build?.artifacts[0]?.id, "hello-bindle-wasm");
	});
});
