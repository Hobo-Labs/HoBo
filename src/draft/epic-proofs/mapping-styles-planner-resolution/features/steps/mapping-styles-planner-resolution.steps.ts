/**
 * Executable step definitions for mapping-styles-planner-resolution.feature.
 *
 * Drives the epic's real planner module (src/mapping-styles-planner-resolution.ts),
 * which composes the promoted topology, mapping-compiler, capability-negotiation,
 * and provider-options technical proofs. Every assertion reads a value produced
 * by planCampDeployment or its emitted control-plane events.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { capabilityRequest } from "../../../../technical-proofs/capability-negotiation-contract/src/capability-negotiation.js";
import {
	createReferenceShopBindle,
	detectMappingStyle,
	perBindingCamp,
	perTierCamp,
	PLAN_REJECTED_FIXTURE_REASON,
	planCampDeployment,
	wholeAppCamp,
} from "../../src/mapping-styles-planner-resolution.js";

type PlanResult = ReturnType<typeof planCampDeployment>;

const shopBindle = createReferenceShopBindle();

function requestsWithDbFeatures(
	features: string[],
	strictness: "require" | "prefer",
) {
	return {
		"shop.db": [
			capabilityRequest({
				port: "database",
				features: ["managed", "postgres"],
				strictness: "require",
			}),
			capabilityRequest({ port: "database", features, strictness }),
		],
		"shop.api": [
			capabilityRequest({
				port: "service",
				features: ["containerService"],
				strictness: "require",
			}),
		],
		"shop.web": [
			capabilityRequest({
				port: "web",
				features: ["cdn"],
				strictness: "require",
			}),
		],
	};
}

// --- Scenario: Same Bindle resolves to AWS or Azure by mapping edit only ---

let awsPlan: PlanResult | undefined;
let azurePlan: PlanResult | undefined;

Given("the reference shop Bindle with mapping-style Camps", () => {
	assert.equal(shopBindle.name, "shop");
});

When("the Camp mapping defaultProvider switches between aws and azure", () => {
	awsPlan = planCampDeployment({ campObject: wholeAppCamp(shopBindle, "aws") });
	azurePlan = planCampDeployment({
		campObject: wholeAppCamp(shopBindle, "azure"),
	});
});

Then(
	"mapping-style deployment.Planned selects the mapped provider for every shop resource",
	() => {
		assert.ok(awsPlan?.ok && azurePlan?.ok, "both plans must resolve");
		assert.equal(awsPlan.event.type, "deployment.Planned");
		assert.equal(azurePlan.event.type, "deployment.Planned");
		assert.deepEqual(
			awsPlan.plan.resources.map(
				(resource: { provider: string }) => resource.provider,
			),
			["aws", "aws", "aws"],
		);
		assert.deepEqual(
			azurePlan.plan.resources.map(
				(resource: { provider: string }) => resource.provider,
			),
			["azure", "azure", "azure"],
		);
	},
);

// --- Scenario: Each mapping style deploys the reference shop app -----------

let stylePlans: Array<{ style: string; result: PlanResult }> = [];

Given("whole-app, per-tier, and per-binding shop Camp mappings", () => {
	const camps = [
		wholeAppCamp(shopBindle, "aws"),
		perTierCamp(shopBindle, "aws"),
		perBindingCamp(shopBindle, "azure"),
	];
	stylePlans = camps.map((campObject) => ({
		style: detectMappingStyle(campObject),
		result: planCampDeployment({ campObject }),
	}));
	assert.deepEqual(
		stylePlans.map((entry) => entry.style),
		["whole-app", "per-tier", "per-binding"],
	);
});

When(
	"the Planner resolves each mapping style with the single-provider objective",
	() => {
		for (const entry of stylePlans) {
			assert.equal(entry.result.ok, true, `${entry.style} plan must resolve`);
			assert.equal(entry.result.mappingStyle, entry.style);
		}
	},
);

Then(
	"each mapping style plan covers shop.db, shop.api, and shop.web with rationale",
	() => {
		for (const entry of stylePlans) {
			assert.ok(entry.result.ok);
			assert.deepEqual(
				entry.result.plan.resources.map(
					(resource: { name: string }) => resource.name,
				),
				["shop.db", "shop.api", "shop.web"],
			);
			const rationale = entry.result.plan.rationale.join(" ");
			assert.match(rationale, new RegExp(`mapping-style:${entry.style}`));
			assert.match(rationale, /objective:single-provider/);
		}
	},
);

// --- Scenario: Required capability miss fails the plan closed --------------

let rejectedPlan: PlanResult | undefined;

Given("an azure shop mapping that requires database.ha", () => {
	rejectedPlan = undefined;
});

When("the Planner negotiates against the azure manifest without ha", () => {
	rejectedPlan = planCampDeployment({
		campObject: wholeAppCamp(shopBindle, "azure"),
		portRequestsByResource: requestsWithDbFeatures(
			["managed", "ha"],
			"require",
		),
	});
});

Then(
	"mapping-style deployment.PlanRejected carries capability.require.unsatisfied",
	() => {
		assert.ok(rejectedPlan);
		assert.equal(rejectedPlan.ok, false);
		assert.equal(rejectedPlan.event.type, "deployment.PlanRejected");
		assert.equal(rejectedPlan.reason, PLAN_REJECTED_FIXTURE_REASON);
		assert.match(rejectedPlan.reason, /capability\.require\.unsatisfied/);
		assert.match(rejectedPlan.reason, /database\.ha/);
	},
);

// --- Scenario: Preferred capability miss degrades with a planWarning -------

let degradedPlan: PlanResult | undefined;

Given("an azure shop mapping that prefers database.ha", () => {
	degradedPlan = undefined;
});

When(
	"the Planner negotiates the preferred capability against the azure manifest",
	() => {
		degradedPlan = planCampDeployment({
			campObject: wholeAppCamp(shopBindle, "azure"),
			portRequestsByResource: requestsWithDbFeatures(["ha"], "prefer"),
		});
	},
);

Then(
	"mapping-style deployment.Planned succeeds with a capability.prefer.degraded planWarning",
	() => {
		assert.ok(degradedPlan);
		assert.equal(degradedPlan.ok, true);
		assert.equal(degradedPlan.event.type, "deployment.Planned");
		assert.ok(
			degradedPlan.plan.planWarnings.some(
				(warning: { kind: string; feature: string }) =>
					warning.kind === "capability.prefer.degraded" &&
					warning.feature === "ha",
			),
			"degradation is surfaced as a planWarning naming the missing feature",
		);
	},
);
