import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../../src/index.js";

const pact = JSON.parse(
	readFileSync(
		new URL("../pacts/iac_pricing_boundary.pact.json", import.meta.url),
		"utf8",
	),
);

describe("external IaC pricing consumer boundary", () => {
	it("reports an unavailable model without authorizing a provider call", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-iac-pact-"));
		const priorHome = process.env.ALCHEMY_HOME;
		const priorTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
		try {
			type Widget = Resource<"Demo.Widget", { size: number }, { id: string }>;
			const Widget = Resource<Widget>("Demo.Widget");
			const stack = Stack(
				"Demo",
				{
					providers: Provider.succeed(Widget, {
						reconcile: () => Effect.succeed({ id: "unexpected" }),
						delete: () => Effect.void,
					}),
					state: inMemoryState(),
				},
				Effect.gen(function* () {
					yield* Widget("widget", { size: 1 });
					return {};
				}),
			);
			const provider = createAlchemyIacProvider({
				stack,
				composite: {
					proofRef: "test:no-source",
					environmentDigest: `sha256:${"e".repeat(64)}`,
					sourceRequirements: [],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) => sourceClaims.length === 0,
				},
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: join(directory, "runtime"),
				target: alchemyTarget({
					targetId: "yard-a",
					tenantId: "tenant-a",
					stackName: "Demo",
					stage: "test",
					programResourceId: "application",
					sourceDigest: `sha256:${"a".repeat(64)}`,
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "widget",
							resourceType: "Demo.Widget",
							providerId: "sandbox",
							providerAccountRef: "account-a",
							productId: "sandbox",
						},
					],
				}),
				financial: {
					assess: (inventory) => ({
						inventory,
						pricing: { state: { case: "unavailable" } },
						quote: { ok: false as const, code: "PRICING_MODEL_UNAVAILABLE" },
						budget: { evaluation: "not-evaluated", reservation: "not-created" },
					}),
					admit: async () => {
						throw new Error("unexpected authorization");
					},
					revalidate: () => false,
					uncertain: () => {
						throw new Error("unexpected uncertainty");
					},
				},
			});
			const assessment = await provider.assessPricing({
				programId: "run",
				deploymentId: "deployment",
				resourceId: "application",
				provider: "sandbox",
				driver: "external",
				action: "apply",
				stackName: "Demo",
			});
			const actual = {
				targetId: assessment.inventory.targetId,
				pricingState: assessment.pricing.state.case,
				quoteCode: assessment.quote.ok ? "priced" : assessment.quote.code,
				budget: assessment.budget,
			};
			expect(actual).toEqual(pact.interactions[0].response.body);
		} finally {
			if (priorHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = priorHome;
			if (priorTelemetry === undefined)
				delete process.env.ALCHEMY_TELEMETRY_DISABLED;
			else process.env.ALCHEMY_TELEMETRY_DISABLED = priorTelemetry;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
