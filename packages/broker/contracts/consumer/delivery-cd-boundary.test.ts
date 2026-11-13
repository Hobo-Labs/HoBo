import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";
import {
	createReconcilerDeliveryPlane,
	type DeliveryPromotionResult,
	DeliverySubmissionError,
} from "../../src/planes.js";
import { parseDeliveryPolicy } from "../../src/policies.js";
import type { PolicyHash, ResolutionReceipt } from "../../src/types.js";

// Consumer side of the broker → @hobo/cd promotion boundary (D14). The broker
// never applies anything: it hands an accepted receipt to CD's promotion
// request and records the ticket CD returns. The pact pins the request the
// broker sends and the two responses it must handle.
const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/broker_delivery_cd.pact.json"),
		"utf8",
	),
);

function receipt(requestId: string): ResolutionReceipt {
	return {
		schemaVersion: "hobo.broker/v1",
		requestId,
		brokerId: "broker:yard-1",
		catalogHash: "sha256:catalog-abc",
		// SAFETY: assertion required at this I/O or test boundary.
		policyHash: "sha256:policy-abc" as PolicyHash,
		placementPolicyId: "pp-bindle",
		placements: [],
		stationId: "station:prod",
		railHash:
			"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	};
}

describe("broker → CD promotion boundary (consumer side of the pact)", () => {
	it("sends the pinned promotion request and records the ticket CD returns", async () => {
		const interaction = pact.interactions[0];
		let seen: JsonObject | undefined;
		const plane = createReconcilerDeliveryPlane({
			requestPromotion: async (request) => {
				seen = JSON.parse(JSON.stringify(request));
				// SAFETY: assertion required at this I/O or test boundary.
				return interaction.response as DeliveryPromotionResult;
			},
		});
		const policy = parseDeliveryPolicy({
			engine: "argo",
			gitopsRepo: "https://git.example/hobo-receipts",
			destinationNamespace: "hobo-prod",
			syncMode: "auto",
			prune: true,
		});
		const ticket = await plane.submit(receipt("req-checkout-1"), policy);
		expect(seen).toMatchObject(interaction.request);
		expect(ticket).toMatchObject(interaction.expectedTicket);
	});

	it("fails closed with delivery-refused when CD refuses", async () => {
		const interaction = pact.interactions[1];
		const plane = createReconcilerDeliveryPlane({
			requestPromotion: async (request) => {
				expect(request).toMatchObject(interaction.request);
				// SAFETY: assertion required at this I/O or test boundary.
				return interaction.response as DeliveryPromotionResult;
			},
		});
		const failure = plane.submit(
			receipt("req-checkout-2"),
			parseDeliveryPolicy({ reconcilerMode: "agent" }),
		);
		await expect(failure).rejects.toThrow(DeliverySubmissionError);
		await expect(failure).rejects.toMatchObject({
			code: interaction.expectedErrorCode,
			remediation: interaction.response.reasons[0].remediation,
		});
	});

	it("fails closed with delivery-transport-failed when the CD call throws", async () => {
		const plane = createReconcilerDeliveryPlane({
			requestPromotion: async () => {
				throw new Error("connection reset");
			},
		});
		await expect(
			plane.submit(
				receipt("req-checkout-3"),
				parseDeliveryPolicy({ reconcilerMode: "conductor" }),
			),
		).rejects.toMatchObject({ code: "delivery-transport-failed" });
	});
});
