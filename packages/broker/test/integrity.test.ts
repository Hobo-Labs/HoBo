import { describe, expect, it } from "vitest";

import { createBroker } from "../src/broker.js";
import { BROKER_EVENTS } from "../src/events.js";
import {
	createMeteredBillingPlane,
	foldMeteredUsage,
	METER_USAGE_RECORDED_EVENT,
} from "../src/metering.js";
import {
	isCatalogedRejectionCode,
	REJECTION_MATRIX,
	rejectionMatrixRow,
} from "../src/rejections.js";
import {
	generateResolutionSigningKey,
	signResolution,
	verifyResolution,
} from "../src/signing.js";
import type { BrokerCatalog, ResolutionReceipt } from "../src/types.js";

const catalog: BrokerCatalog = {
	catalogHash: "sha256:catalog-abc",
	definitions: () => [
		{
			id: "@hobo/provider-cloudflare:hobo:http-service",
			providerId: "@hobo/provider-cloudflare",
			port: "hobo:http-service",
			features: [],
			regions: ["us-east-1"],
			cost: { sku: "cf-svc", unit: "hour", marginalPrice: "0.02" },
			satisfies: (req) =>
				req.port === "hobo:http-service" ? { kind: "full" } : { kind: "none" },
		},
	],
};

const basePolicies = {
	schemaVersion: "hobo.broker/v1",
	brokerId: "broker:yard-1",
	placementPolicies: [
		{ id: "pp-bindle", scopeKind: "bindle", objective: "min-cost" },
	],
	billing: {
		quota: "deployments/day",
		quotaUsed: 0,
		quotaLimit: 10,
		budgetUsd: 100,
		spendCapUsd: 50,
	},
	delivery: { engine: "in-proc", syncMode: "manual" },
};

const baseRequest = {
	schemaVersion: "hobo.broker/v1",
	requestId: "req-1",
	scope: { bindleId: "bindle:site" },
	requirements: [{ resourceId: "api", port: "hobo:http-service" }],
	spendEstimateUsd: 10,
};

describe("receipt integrity — Ed25519 over canonical JSON", () => {
	it("signs resolutions when a key is configured and verification round-trips", async () => {
		const key = generateResolutionSigningKey();
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			signingKey: key,
		});
		const result = await broker.resolve(baseRequest);
		expect(result.outcome).toBe("resolved");
		expect(result.signature?.algorithm).toBe("ed25519");
		expect(result.signature?.payloadDigest).toMatch(/^sha256:/);
		expect(
			result.events.some(
				(event) => event.type === BROKER_EVENTS.ResolutionSigned,
			),
		).toBe(true);

		// SAFETY: assertion required at this I/O or test boundary.
		const receipt = result.receipt as ResolutionReceipt;
		const signature = result.signature;
		if (signature === undefined) throw new Error("expected a signature");
		expect(verifyResolution(receipt, signature)).toBe(true);

		// Tampering with a single placement field fails verification.
		const tampered: ResolutionReceipt = {
			...receipt,
			placements: receipt.placements.map((placement) => ({
				...placement,
				marginalPrice: "0.00",
			})),
		};
		expect(verifyResolution(tampered, signature)).toBe(false);
	});

	it("signs rejections too, and a foreign key does not verify", async () => {
		const key = generateResolutionSigningKey();
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			signingKey: key,
		});
		const result = await broker.resolve({
			...baseRequest,
			spendEstimateUsd: 500,
		});
		expect(result.outcome).toBe("rejected");
		const rejection = result.rejection;
		const signature = result.signature;
		if (rejection === undefined || signature === undefined) {
			throw new Error("expected a signed rejection");
		}
		expect(verifyResolution(rejection, signature)).toBe(true);

		const foreign = signResolution(rejection, generateResolutionSigningKey());
		expect(verifyResolution(rejection, signature)).toBe(true);
		expect(
			verifyResolution({ ...rejection, requestId: "req-forged" }, foreign),
		).toBe(false);
	});
});

describe("metered billing plane", () => {
	const usage = [
		{ type: METER_USAGE_RECORDED_EVENT, data: { costUsd: 30 } },
		{ type: METER_USAGE_RECORDED_EVENT, data: { costUsd: 45.5 } },
		{ type: "broker.Requested", data: {} },
		{ type: METER_USAGE_RECORDED_EVENT, data: { costUsd: "bad" } },
	];

	it("folds meter.UsageRecorded facts into observed spend", () => {
		const fold = foldMeteredUsage(usage);
		expect(fold.spentUsd).toBe(75.5);
		expect(fold.sampleCount).toBe(2);
		expect(fold.unknownSampleCount).toBe(1);
	});

	it("authorizes against the metered remaining budget", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			billingPlane: createMeteredBillingPlane(usage.slice(0, 3)),
		});
		// Budget 100, metered spend 75.5 → remaining 24.5: 10 fits...
		const ok = await broker.resolve(baseRequest);
		expect(ok.outcome).toBe("resolved");
		// ...30 does not.
		const over = await broker.resolve({
			...baseRequest,
			requestId: "req-2",
			spendEstimateUsd: 30,
		});
		expect(over.outcome).toBe("rejected");
		expect(over.rejection?.reasons[0]?.code).toBe("budget-exceeded");
	});
});

describe("rejection matrix", () => {
	it("pins every code to a plane and a remediation", () => {
		for (const row of REJECTION_MATRIX) {
			expect(row.code.length).toBeGreaterThan(0);
			expect(row.remediation.length).toBeGreaterThan(0);
			expect(rejectionMatrixRow(row.code)).toEqual(row);
		}
	});

	it("covers every reason the broker's own reject paths emit", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const rejections = [
			await broker.resolve({ ...baseRequest, spendEstimateUsd: 500 }),
			await broker.resolve({
				...baseRequest,
				requirements: [{ resourceId: "q", port: "hobo:message-queue" }],
			}),
		];
		for (const result of rejections) {
			for (const reason of result.rejection?.reasons ?? []) {
				// contracts-plane codes are owned by @hobo/contracts' compat gate;
				// every broker-owned plane must be cataloged.
				if (reason.plane === "contracts") continue;
				expect(
					isCatalogedRejectionCode(reason.code),
					`uncataloged rejection code ${reason.code}`,
				).toBe(true);
			}
		}
	});
});
