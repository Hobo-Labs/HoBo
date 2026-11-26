/**
 * Every case is a line in `gatekeeper.cases.jsonl`.
 *
 * `evaluateGatekeeper` takes one options object and every gate input in it is
 * already JSON — except `policyPack`, whose rules are closures. Those are the
 * only thing that cannot be written down, so they live here as a named set and
 * a case selects one by name. Everything else is data.
 */

import { describeConcern } from "@hobo/contract-harness";
import {
	createBoundaryContract,
	definePolicyRule,
	evaluateGatekeeper,
	type PolicyPack,
} from "../src/index.js";

const edge = {
	kind: "event",
	producer: "checkout-api@1.2.0",
	consumer: "checkout-worker@1.7.0",
	channel: "orders.http",
	operation: "order.created",
} as const;

const DEPLOYED = createBoundaryContract({
	id: "contract-orders-http",
	version: "1.2.0",
	edge,
	requiredLayout: {
		format: "json-schema",
		requiredFields: ["id", "tenantId", "total"],
		providedFields: ["id", "tenantId", "total"],
	},
});

/** Adds a field: widening, so the consumer keeps working. */
const COMPATIBLE = createBoundaryContract({
	id: "contract-orders-http",
	version: "1.3.0",
	edge: { ...edge, producer: "checkout-api@2.4.0" },
	requiredLayout: {
		format: "json-schema",
		requiredFields: ["id", "tenantId", "total"],
		providedFields: ["id", "tenantId", "total", "currency"],
	},
});

/** Drops `tenantId`: the removal the contracts gate exists to catch. */
const BREAKING = createBoundaryContract({
	id: "contract-orders-http",
	version: "3.0.0",
	edge: { ...edge, producer: "checkout-api@3.0.0" },
	requiredLayout: {
		format: "json-schema",
		requiredFields: ["id", "total"],
		providedFields: ["id", "total"],
	},
});

const CONTRACTS = { compatible: COMPATIBLE, breaking: BREAKING };

const pack = (
	id: string,
	decide: () => ReturnType<Parameters<typeof definePolicyRule>[0]["decide"]>,
): PolicyPack => ({
	id,
	version: "1.0.0",
	rules: [
		definePolicyRule({
			id: `${id}-rule`,
			when: (request) => request.action === "hobo:delta:promote",
			decide,
		}),
	],
});

/** The closures, which are the one thing a case cannot spell out. */
interface PolicyPackById {
	[id: string]: PolicyPack | undefined;
}

const PACKS: PolicyPackById = {
	none: undefined,
	freeze: pack("yard-prod-freeze", () => ({
		effect: "deny",
		reason: "prod deploys are frozen by mandatory policy",
		violations: ["deploy-freeze-active"],
	})),
	approval: pack("yard-prod-governance", () => ({
		effect: "require-approval",
		reason: "production deploy requires approval",
		obligations: [
			{
				id: "obl:approval:checkout-prod",
				kind: "require-approval",
				satisfied: false,
			},
		],
	})),
};

const REQUEST = {
	subject: { kind: "agent", id: "spiffe://tenant-a/yard/prod/agent/deployer" },
	action: "hobo:delta:promote",
	resource: { kind: "deployment", id: "deployment:checkout-prod" },
	phase: "apply",
	context: { target: "prod" },
};
const PLAN = {
	objective: "cost",
	resources: [{ name: "checkout-api", port: "hobo:http/handler" }],
};
const GOOD_QUOTA = { quota: "deployments/day", used: 7, limit: 20 };

interface Ask {
	readonly candidate?: keyof typeof CONTRACTS;
	readonly pack?: keyof typeof PACKS;
	readonly costQuota?: unknown;
	readonly obligations?: readonly unknown[];
	readonly secretlessConfig?: unknown;
	readonly bindingDelivery?: unknown;
	readonly canMigrate?: unknown;
	readonly residency?: unknown;
}

describeConcern("gatekeeper", {
	cases: `${import.meta.dirname}/gatekeeper.cases.jsonl`,
	subject: () => ({
		decide: (ask: Ask = {}) => {
			const {
				candidate = "compatible",
				pack: packName = "none",
				...rest
			} = ask;
			// SAFETY: assertion required at this I/O or test boundary.
			const result = evaluateGatekeeper({
				request: REQUEST,
				deployedState: { contracts: [DEPLOYED] },
				candidate: { plan: PLAN, contracts: [CONTRACTS[candidate]] },
				costQuota: GOOD_QUOTA,
				...(PACKS[packName] ? { policyPack: PACKS[packName] } : undefined),
				...rest,
			} as never);
			return {
				decision: result.decision,
				// Sorted and whole: a `find(gate === …)` assertion stays green when
				// an unrelated gate also fires, which is what this replaces.
				reasons: result.reasons
					.map((reason) => `${reason.gate}:${reason.code}`)
					.sort(),
				detailsByCode: Object.fromEntries(
					result.reasons.map((reason) => [reason.code, reason.details ?? null]),
				),
				policyDecidedType: result.policyDecided.type,
				policyEffect: result.policyDecided.data.effect,
				canDeployOk: result.canDeploy.ok,
				costQuotaOk: result.costQuota.ok,
				obligationIds: result.obligations.map((o) => o.id).sort(),
				eventTypes: [...new Set(result.events.map((e) => e.type))].sort(),
			};
		},
	}),
});
