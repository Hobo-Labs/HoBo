import { readFileSync } from "node:fs";
import { fromJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { meshIdentityFromPem } from "@hobo/ci/mesh";
import { expect, it } from "vitest";
import { z } from "zod";
import { askRelay, relayRefusal } from "../../../scripts/ci/route-runner.mts";
import {
	createMemoryFleetVerdictKv,
	createMemoryFleetVerdicts,
	type FleetVerdictSettings,
	MEMORY_FLEET_VERDICT_KEYS,
	parseFleetReporters,
	parseFleetVerdictPath,
} from "../src/fleet-verdict.js";
import { signedFleetVerdictRequest } from "../src/fleet-verdict-auth.js";
import type { FleetVerdictService } from "../src/hosted-control.js";
import {
	controlHttp,
	NOW,
	strictGithub,
} from "../test/fixtures/control-api-github.js";
import { BOX_1_KEY_PEM } from "../test/fixtures/fleet-reporter-keys.js";

const Interaction = z.object({
	description: z.string(),
	providerStates: z.array(z.object({ name: z.string() })).optional(),
	request: z.object({
		method: z.enum(["GET", "POST", "PUT"]),
		path: z.string(),
		query: z.string().optional(),
		headers: z.record(z.string(), z.string()),
		body: z.json().optional(),
	}),
	response: z.object({
		status: z.number(),
		headers: z.record(z.string(), z.string()),
		body: z.json(),
	}),
});
const pact = z
	.object({
		consumer: z.object({
			name: z.literal("HoboCiRunnerRoutingAndFleetReporter"),
		}),
		provider: z.object({ name: z.literal("HoboCiRelayFleetVerdictApi") }),
		metadata: z.object({
			pactSpecification: z.object({ version: z.literal("3.0.0") }),
			consumerFixtures: z.object({
				now: z.literal(NOW),
				publicOrigin: z.literal("https://ci.hobo.test"),
				reporters: z.json(),
				dailyBlockMinutes: z.number(),
				workflowTokens: z.record(z.string(), z.string()),
				configuration: z.json(),
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
const fixtures = pact.metadata.consumerFixtures;
const reporters = parseFleetReporters(JSON.stringify(fixtures.reporters));
if (!reporters) throw new Error("the Pact's enrollment is not one");
const settings: FleetVerdictSettings = {
	reporters,
	serving: true,
	dailyBlockMinutes: fixtures.dailyBlockMinutes,
};
const configuration = () =>
	fromJsonString(ConfigurationSchema, JSON.stringify(fixtures.configuration));

/** A workflow verifier that knows the Pact's tokens and no others. */
const workflowIdentity = {
	verify: async (token: string) => {
		const repository = Object.entries(fixtures.workflowTokens).find(
			([, value]) => value === token,
		)?.[0];
		if (!repository) throw new Error("invalid identity");
		return { repository, repositoryId: "1", eventName: "schedule", runId: "1" };
	},
};

async function assertResponse(
	response: Response,
	expected: z.infer<typeof Interaction>["response"],
) {
	expect(response.status).toBe(expected.status);
	for (const [key, value] of Object.entries(expected.headers))
		expect(response.headers.get(key)).toBe(value);
	expect(await response.json()).toEqual(expected.body);
}

it("serves the fleet verdict Pact over real HTTP: read by anyone, reported only by an enrolled reporter's signature, agreed, and shown to the repository's own workflows", async () => {
	const nowMs = Date.parse(NOW);
	const kv = createMemoryFleetVerdictKv(() => nowMs);
	const refused: string[] = [];
	const service: FleetVerdictService = {
		store: createMemoryFleetVerdicts(() => nowMs, kv),
		settings: () => settings,
		workflowIdentity,
		log: (event, fields) =>
			refused.push(`${event}:${fields.reporter}:${fields.reason}`),
	};
	const states = new Map([
		[
			"the hobo label's allowance on hobo-labs/hobo is spent",
			async () => {
				const repository = parseFleetVerdictPath(
					"/v1/fleet/verdicts/hobo-labs/hobo",
				);
				if (!repository) throw new Error("no repository");
				const key = MEMORY_FLEET_VERDICT_KEYS.allowance(repository);
				const [current] = await kv.getMany([key]);
				const written = await kv.write(
					key,
					JSON.stringify({
						labels: {
							hobo: {
								windowStart: new Date(nowMs - 3_600_000).toISOString(),
								blockedSeconds: 14_400,
								lastCountedAt: new Date(nowMs).toISOString(),
							},
						},
					}),
					86_400_000,
					current?.version,
				);
				expect(written).toBe(true);
			},
		],
	]);
	const h = await controlHttp({
		github: strictGithub([]).github,
		configuration: configuration(),
		fleetVerdicts: service,
	});
	const exercised = new Set<string>();
	let negativeControl = false;
	try {
		expect(pact.interactions).toHaveLength(23);
		for (const interaction of pact.interactions) {
			for (const state of interaction.providerStates ?? []) {
				const arrange = states.get(state.name);
				if (!arrange) throw new Error(`unknown provider state ${state.name}`);
				await arrange();
			}
			const init: RequestInit = {
				method: interaction.request.method,
				headers: interaction.request.headers,
			};
			if (interaction.request.body !== undefined)
				init.body = JSON.stringify(interaction.request.body);
			const query = interaction.request.query
				? `?${interaction.request.query}`
				: "";
			const response = await fetch(
				`${h.base}${interaction.request.path}${query}`,
				init,
			);
			if (!negativeControl) {
				await expect(
					assertResponse(response.clone(), {
						...interaction.response,
						status: 503,
					}),
				).rejects.toThrow();
				negativeControl = true;
			}
			await assertResponse(response, interaction.response);
			exercised.add(interaction.description);
		}
		expect(negativeControl).toBe(true);
		expect([...exercised].sort()).toEqual(
			pact.interactions.map((entry) => entry.description).sort(),
		);
		// Every refused report was logged with the reporter it named and why.
		expect(refused).toEqual([
			"hobo_ci_fleet_verdict_refused:box-1:bad-request",
			"hobo_ci_fleet_verdict_refused:box-9:unknown-reporter",
			"hobo_ci_fleet_verdict_refused:box-1:bad-signature",
			"hobo_ci_fleet_verdict_refused:box-1:bad-signature",
			"hobo_ci_fleet_verdict_refused:box-1:clock-skew",
			"hobo_ci_fleet_verdict_refused:box-1:not-found",
			"hobo_ci_fleet_verdict_refused:box-2:invalid-report",
			"hobo_ci_fleet_verdict_refused:box-1:replayed",
		]);
	} finally {
		await h.stop();
	}
});

it("answers a relay that keeps no verdicts as blocking nothing, and refuses its reports", async () => {
	const h = await controlHttp({ github: strictGithub([]).github });
	try {
		const read = await fetch(`${h.base}/v1/fleet/verdicts/Hobo-Labs/HoBo`);
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({
			repository: "hobo-labs/hobo",
			blocked: {},
		});
		const report = await fetch(`${h.base}/v1/fleet/verdicts/Hobo-Labs/HoBo`, {
			method: "PUT",
			body: "{}",
		});
		expect(report.status).toBe(503);
		const status = await fetch(`${h.base}/v1/fleet/reporters/Hobo-Labs/HoBo`);
		expect(status.status).toBe(503);
	} finally {
		await h.stop();
	}
});

it("is switched off by the kill switch: reads block nothing, reports answer 503", async () => {
	const nowMs = Date.parse(NOW);
	const store = createMemoryFleetVerdicts(() => nowMs);
	let serving = true;
	const h = await controlHttp({
		github: strictGithub([]).github,
		configuration: configuration(),
		fleetVerdicts: {
			store,
			settings: () => ({ ...settings, serving }),
			workflowIdentity,
		},
	});
	const identity = meshIdentityFromPem(BOX_1_KEY_PEM);
	let sequence = nowMs;
	const report = () => {
		sequence += 1;
		const signed = signedFleetVerdictRequest({
			identity,
			reporterId: "box-1",
			origin: fixtures.publicOrigin,
			repository: "hobo-labs/hobo",
			body: '{"blocked":{"hobo-trunk":{"reason":"no-capacity"}},"ttlSeconds":180,"mode":"report"}',
			issuedAt: new Date(nowMs).toISOString(),
			sequence: String(sequence),
		});
		return fetch(`${h.base}${signed.path}`, {
			method: "PUT",
			headers: signed.headers,
			body: signed.body,
		});
	};
	const read = async () =>
		(await (await fetch(`${h.base}/v1/fleet/verdicts/hobo-labs/hobo`)).json())
			.blocked;
	try {
		expect((await report()).status).toBe(200);
		expect(await read()).toEqual({ "hobo-trunk": { reason: "no-capacity" } });
		serving = false;
		expect(await read()).toEqual({});
		const refused = await report();
		expect(refused.status).toBe(503);
		serving = true;
		expect(await read()).toEqual({ "hobo-trunk": { reason: "no-capacity" } });
	} finally {
		await h.stop();
	}
});

it("is asked by the routing job's own client and reported by a signed reporter, end to end", async () => {
	const nowMs = Date.parse(NOW);
	const kept = createMemoryFleetVerdicts(() => nowMs);
	const reads: string[] = [];
	const h = await controlHttp({
		github: strictGithub([]).github,
		configuration: configuration(),
		fleetVerdicts: {
			store: {
				...kept,
				read: (repository, enrolled) => {
					reads.push(repository);
					return kept.read(repository, enrolled);
				},
			},
			// box-1 alone serves hobo-trunk, so its report alone decides it.
			settings: () => settings,
		},
	});
	const identity = meshIdentityFromPem(BOX_1_KEY_PEM);
	let sequence = nowMs;
	const report = async (blocked: string) => {
		sequence += 1;
		const signed = signedFleetVerdictRequest({
			identity,
			reporterId: "box-1",
			origin: fixtures.publicOrigin,
			repository: "Hobo-Labs/HoBo",
			body: `{"blocked":${blocked},"ttlSeconds":180,"mode":"report"}`,
			issuedAt: new Date(nowMs).toISOString(),
			sequence: String(sequence),
		});
		const response = await fetch(`${h.base}${signed.path}`, {
			method: "PUT",
			headers: signed.headers,
			body: signed.body,
		});
		expect(response.status).toBe(200);
	};
	const ask = () => askRelay({ origin: h.base, repository: "Hobo-Labs/HoBo" });
	try {
		// Nothing reported: the routing job is told nothing is blocked.
		const before = await ask();
		expect(before).toEqual({ kind: "verdict", blocked: new Map() });
		expect(relayRefusal(before, "hobo-trunk")).toBeUndefined();

		await report('{"hobo-trunk":{"reason":"no-capacity"}}');
		const blocked = await ask();
		expect(relayRefusal(blocked, "hobo-trunk")).toBe(
			"the relay keeps new work off hobo-trunk: no node can admit a job and none has a free slot",
		);
		expect(relayRefusal(blocked, "hobo")).toBeUndefined();

		await report("{}");
		expect(relayRefusal(await ask(), "hobo-trunk")).toBeUndefined();

		// Asking about a repository no account is connected to reads nothing
		// from the store: a made-up name costs the relay no lookup.
		const asked = reads.length;
		expect(
			await askRelay({ origin: h.base, repository: "acme/unknown" }),
		).toEqual({ kind: "verdict", blocked: new Map() });
		expect(reads).toHaveLength(asked);
		expect(new Set(reads)).toEqual(new Set(["hobo-labs/hobo"]));
	} finally {
		await h.stop();
	}
});
