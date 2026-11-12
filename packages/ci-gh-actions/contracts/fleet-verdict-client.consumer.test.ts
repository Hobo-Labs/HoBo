import { readFileSync } from "node:fs";
import { meshIdentityFromPem } from "@hobo/ci/mesh";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CiRelayClientError, createCiRelayClient } from "../src/client.js";
import { parseFleetVerdictReport } from "../src/fleet-verdict.js";
import { signedFleetVerdictRequest } from "../src/fleet-verdict-auth.js";
import {
	BOX_1_KEY_PEM,
	BOX_2_KEY_PEM,
} from "../test/fixtures/fleet-reporter-keys.js";

const ORIGIN = "https://relay.example";
const Interaction = z.object({
	description: z.string(),
	request: z.object({
		method: z.enum(["GET", "PUT", "POST"]),
		path: z.string(),
		query: z.string().optional(),
		headers: z.record(z.string(), z.string()),
		body: z.json().optional(),
	}),
	response: z.object({ status: z.number(), body: z.json() }),
});
const Signing = z.object({
	description: z.string(),
	signedBy: z.enum(["box-1", "box-2"]),
	reporter: z.string(),
	origin: z.string(),
	repository: z.string(),
	issuedAt: z.string(),
	sequence: z.string(),
});
const pact = z
	.object({
		metadata: z.object({
			consumerFixtures: z.object({
				signing: z.array(Signing),
				workflowTokens: z.record(z.string(), z.string()),
			}),
		}),
		interactions: z.array(Interaction),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL("./fleet-verdict-boundary.pact.json", import.meta.url),
				"utf8",
			),
		),
	);
const keys = {
	"box-1": meshIdentityFromPem(BOX_1_KEY_PEM),
	"box-2": meshIdentityFromPem(BOX_2_KEY_PEM),
};

describe("the fleet reporter as a consumer of the verdict routes", () => {
	it("signs every report the Pact sends exactly as the shared signing function does", () => {
		const reports = pact.interactions.filter(
			(entry) => entry.request.method === "PUT",
		);
		expect(reports.map((entry) => entry.description).sort()).toEqual(
			pact.metadata.consumerFixtures.signing
				.map((entry) => entry.description)
				.sort(),
		);
		for (const signing of pact.metadata.consumerFixtures.signing) {
			const interaction = reports.find(
				(entry) => entry.description === signing.description,
			);
			if (!interaction)
				throw new Error(`no interaction ${signing.description}`);
			const body = JSON.stringify(interaction.request.body);
			// The reporter only ever sends a body it could parse back.
			expect(parseFleetVerdictReport(body), signing.description).toBeDefined();
			const request = signedFleetVerdictRequest({
				identity: keys[signing.signedBy],
				reporterId: signing.reporter,
				origin: signing.origin,
				repository: signing.repository,
				body,
				issuedAt: signing.issuedAt,
				sequence: signing.sequence,
			});
			expect(request.path, signing.description).toBe(interaction.request.path);
			expect(request.headers, signing.description).toEqual(
				interaction.request.headers,
			);
			expect(request.body).toBe(body);
		}
	});

	it("reads the agreed verdict", async () => {
		const standing = pact.interactions.find((entry) =>
			entry.description.startsWith("answer the agreed verdict"),
		);
		if (!standing) throw new Error("the Pact has no agreed verdict");
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: () => "unused-account-token-of-at-least-32-chars",
			fetch: async (url, init) => {
				expect(String(url)).toBe(`${ORIGIN}${standing.request.path}`);
				expect(init?.method).toBe("GET");
				return Response.json(standing.response.body);
			},
		});
		const verdict = await client.getFleetVerdict("Hobo-Labs/HoBo");
		expect(verdict.blocked.hobo?.reason).toBe("no-capacity");
		expect(verdict.expiresAt).toBe("2026-10-27T00:03:00.000Z");
	});

	it("reads the reporters' status with the workflow's token, and a sanitized refusal", async () => {
		for (const interaction of pact.interactions.filter((entry) =>
			entry.request.path.startsWith("/v1/fleet/reporters/"),
		)) {
			const authorization = interaction.request.headers.Authorization;
			if (!authorization) continue;
			let calls = 0;
			const client = createCiRelayClient({
				origin: ORIGIN,
				accountToken: () => "unused-account-token-of-at-least-32-chars",
				fetch: async (url, init) => {
					calls++;
					expect(String(url)).toBe(`${ORIGIN}${interaction.request.path}`);
					expect(init?.method).toBe("GET");
					expect(init?.redirect).toBe("error");
					expect(new Headers(init?.headers).get("authorization")).toBe(
						authorization,
					);
					return Response.json(interaction.response.body, {
						status: interaction.response.status,
					});
				},
			});
			const repository = interaction.request.path
				.split("/")
				.slice(-2)
				.join("/");
			const asking = client.getFleetReporters(
				repository,
				authorization.slice("Bearer ".length),
			);
			if (interaction.response.status >= 400)
				await expect(asking).rejects.toMatchObject({
					name: "CiRelayClientError",
					status: interaction.response.status,
					message: `relay request failed (${interaction.response.status})`,
				});
			else {
				const status = await asking;
				expect(status.$typeName).toBe(
					"hobo.ci.gh_actions.v1.FleetReporterStatusList",
				);
				expect(status.reporters.map((entry) => entry.live)).toEqual([
					true,
					true,
				]);
				expect(status.allowance.hobo?.spent).toBe(true);
			}
			expect(calls).toBe(1);
		}
	});

	it("never asks for something that is not a repository, or with a token that is not one", () => {
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: () => "unused-account-token-of-at-least-32-chars",
			fetch: async () => {
				throw new Error("nothing should be sent");
			},
		});
		for (const send of [
			() => client.getFleetVerdict("../accounts/self/policy"),
			() => client.getFleetVerdict("hobo-labs"),
			() => client.getFleetReporters("hobo-labs/hobo/../x", "token"),
		])
			expect(send).toThrow(CiRelayClientError);
		return Promise.all([
			expect(client.getFleetReporters("hobo-labs/hobo", "")).rejects.toThrow(
				CiRelayClientError,
			),
			expect(
				client.getFleetReporters("hobo-labs/hobo", "a token"),
			).rejects.toThrow(CiRelayClientError),
		]);
	});
});
