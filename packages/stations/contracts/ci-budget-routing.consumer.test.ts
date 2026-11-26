import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { foldBudgetSignals } from "../../broker/src/budget-signals.js";
import { createCiRelayClient } from "../../ci-gh-actions/src/client.js";
import { createCiBudgetRoutingBridge } from "../src/ci-routing.js";

it("executes both CI policy Pact interactions through the shipped client and Station budget bridge", async () => {
	// SAFETY: the hand-authored Pact is a test-only I/O boundary; wire account
	// bodies are independently parsed by the client's generated protobuf schemas.
	const pact = JSON.parse(
		readFileSync(
			new URL("./ci-budget-routing.pact.json", import.meta.url),
			"utf8",
		),
	) as {
		consumer: { name: string };
		provider: { name: string };
		interactions: {
			request: {
				method: "GET" | "PUT";
				path: string;
				headers: Record<string, string>;
				body?: object;
			};
			response: { status: number; body: object };
		}[];
	};
	expect(pact.consumer.name).toBe("HoboStationsCiBudgetRouting");
	expect(pact.provider.name).toBe("HoboCiAccountControlApi");
	expect(pact.interactions).toHaveLength(2);
	let matched = 0;
	const client = createCiRelayClient({
		origin: "https://relay.example",
		accountToken: () => "station-ci-budget-token-with-at-least-32-characters",
		fetch: async (url, init) => {
			const interaction = pact.interactions[matched++];
			if (!interaction) throw new Error("unmatched CI account request");
			expect(String(url)).toBe(
				`https://relay.example${interaction.request.path}`,
			);
			expect(init?.method).toBe(interaction.request.method);
			expect(Object.fromEntries(new Headers(init?.headers))).toEqual(
				Object.fromEntries(new Headers(interaction.request.headers)),
			);
			if (interaction.request.body !== undefined)
				expect(JSON.parse(String(init?.body))).toEqual(
					interaction.request.body,
				);
			else expect(init?.body).toBeUndefined();
			return Response.json(interaction.response.body, {
				status: interaction.response.status,
			});
		},
	});
	const bridge = createCiBudgetRoutingBridge({
		policy: {
			accountId: "account-a",
			tenantId: "tenant-a",
			normalOfferIds: ["github"],
			thresholds: [{ thresholdFraction: 0.8, offerIds: ["depot"] }],
		},
		client,
	});
	const [signal] = foldBudgetSignals(
		[
			{
				type: "meter.UsageRecorded",
				data: { tenantId: "tenant-a", costUsd: 80 },
			},
		],
		{ budgetUsd: 100, thresholds: [0.8], tenantId: "tenant-a" },
	).signals;
	expect(signal).toBeDefined();
	expect(await bridge.accept(JSON.stringify(signal))).toEqual({
		changed: true,
		revision: 2,
	});
	expect(matched).toBe(2);
});
