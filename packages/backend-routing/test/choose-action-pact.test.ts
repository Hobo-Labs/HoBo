/**
 * The `chooseAction` boundary, replayed.
 *
 * `contracts/one-active-choose-action.pact.json` states what the shared
 * one-active loop (`createOneActiveFleet`, the consumer) may expect when it
 * asks this package (the provider) to choose: given the current assignment and
 * one `NamedObservation` per member, `routeFleetByBudget` answers a
 * loss-tolerant fleet and `decideFleet` a database fleet. Each interaction is
 * run here against the same functions the hosts pass as `chooseAction`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import {
	Health,
	type NamedObservation,
	ObservationSchema,
	parseMemberName,
	UsageMeasurementSchema,
} from "@hobo/fleet";
import { parseAssignmentEntry } from "@hobo/fleet/assignment";
import { describe, expect, it } from "vitest";
import {
	billingPeriod,
	DEFAULT_FLEET_POLICY,
	DEFAULT_FLEET_ROUTING_MARKS,
	decideFleet,
	parseFleetFinancialModel,
	parseFleetOffer,
	routeFleetByBudget,
} from "../src/index.js";

type WireObservation = {
	readonly name: string;
	readonly health: string;
	readonly failingForMs: number;
	readonly ready?: boolean;
	readonly lagMs?: number;
	readonly usage: readonly { readonly unit: string; readonly used: number }[];
};
type Interaction = {
	readonly description: string;
	readonly request: {
		readonly path: string;
		readonly body: {
			readonly active: string;
			readonly members: readonly string[];
			readonly observations: readonly WireObservation[];
			readonly workload?: readonly {
				readonly unit: string;
				readonly used: number;
			}[];
		};
	};
	readonly response: {
		readonly body: {
			readonly action: string;
			readonly target?: string;
			readonly lossWindowMs?: number;
			readonly reasons: readonly string[];
			readonly candidateReasons?: Readonly<Record<string, readonly string[]>>;
		};
	};
};
type Pact = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly Interaction[];
};

// SAFETY: the pact is this package's own checked-in contract with this shape.
const pact = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/one-active-choose-action.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
) as Pact;

const NOW = Date.UTC(2026, 10, 11);
const DAY = 24 * 3_600_000;
const evidence = { source: "pact numbers", observedAt: "2026-11-11" };
const HEALTH = new Map([
	["HEALTH_REACHABLE", Health.REACHABLE],
	["HEALTH_UNREACHABLE", Health.UNREACHABLE],
	["HEALTH_QUOTA_EXHAUSTED", Health.QUOTA_EXHAUSTED],
	["HEALTH_AUTH", Health.AUTH],
	["HEALTH_UNKNOWN", Health.UNKNOWN],
]);

const offers = [
	parseFleetOffer({
		tier: "free",
		capMicros: undefined,
		model: parseFleetFinancialModel({
			backend: "upstash",
			plan: "free",
			fixedMonthlyFeeMicros: 0,
			allowances: [
				{
					unit: "commands",
					included: 500_000,
					beyond: "hard-stop",
					meteredMicrosPerUnit: undefined,
				},
			],
			evidence,
		}),
	}),
	parseFleetOffer({
		tier: "free",
		capMicros: undefined,
		model: parseFleetFinancialModel({
			backend: "valkey",
			plan: "free",
			fixedMonthlyFeeMicros: 0,
			allowances: [],
			evidence,
		}),
	}),
];
const models = ["a", "b", "c"].map((backend) =>
	parseFleetFinancialModel({
		backend,
		plan: "placeholder capped",
		fixedMonthlyFeeMicros: 0,
		allowances: [
			{
				unit: "operations",
				included: 100_000,
				beyond: "hard-stop",
				meteredMicrosPerUnit: undefined,
			},
		],
		evidence,
	}),
);

function observed(wire: WireObservation): NamedObservation {
	return {
		name: parseMemberName(wire.name),
		observation: create(ObservationSchema, {
			health: HEALTH.get(wire.health) ?? Health.UNKNOWN,
			failingForMs: wire.failingForMs,
			ready: wire.ready,
			lagMs: wire.lagMs,
			usage: wire.usage.map((entry) => create(UsageMeasurementSchema, entry)),
		}),
	};
}

describe("chooseAction boundary contract", () => {
	it("names both sides and has interactions", () => {
		expect(pact.consumer.name).toBe("hobo-one-active-loop");
		expect(pact.provider.name).toBe("hobo-backend-routing");
		expect(pact.interactions.length).toBeGreaterThanOrEqual(4);
	});

	for (const interaction of pact.interactions)
		it(interaction.description, () => {
			const { body } = interaction.request;
			const expected = interaction.response.body;
			const assignment = parseAssignmentEntry({
				epoch: 3,
				active: parseMemberName(body.active),
				sealed: false,
				target: undefined,
				reason: "pact",
				lossWindowMs: undefined,
				decidedAtMs: NOW - 7 * DAY,
				decidedBy: "pact",
				members: undefined,
			});
			const observations = body.observations.map(observed);
			const answer =
				interaction.request.path === "/choose/route-by-budget"
					? routeFleetByBudget({
							assignment,
							members: body.members,
							observations,
							workload: (body.workload ?? []).map((entry) => ({
								unit: entry.unit === "commands" ? "commands" : "operations",
								used: entry.used,
							})),
							offers,
							marks: DEFAULT_FLEET_ROUTING_MARKS,
							period: billingPeriod(NOW),
							nowMs: NOW,
						})
					: decideFleet({
							assignment,
							observations,
							models,
							policy: DEFAULT_FLEET_POLICY,
							period: billingPeriod(NOW),
							checkBudget: () => ({ ok: true, code: "ok", reason: "ok" }),
							nowMs: NOW,
						});
			expect(answer.action).toBe(expected.action);
			expect(answer.target).toBe(expected.target);
			expect(answer.reasons).toEqual(expected.reasons);
			if (expected.lossWindowMs !== undefined && "lossWindowMs" in answer)
				expect(answer.lossWindowMs).toBe(expected.lossWindowMs);
			for (const [name, reasons] of Object.entries(
				expected.candidateReasons ?? {},
			))
				expect(
					answer.candidates.find((entry) => entry.backend === name)?.reasons,
				).toEqual(reasons);
		});
});
