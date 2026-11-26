import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createGithubAppTransport } from "../src/github.js";
import {
	applyOnboarding,
	connectRepository,
	createGithubAppManifest,
	githubAppManifestJson,
	type OnboardingGithubPort,
	OnboardingPendingError,
	parseOnboardingPlan,
	prepareOnboarding,
} from "../src/onboarding.js";

const Interaction = z.object({
	description: z.string(),
	request: z.object({
		scope: z.enum(["app", "installation"]),
		method: z.enum(["GET", "POST", "PUT"]),
		path: z.string(),
		body: z.json().optional(),
	}),
	response: z.object({ status: z.number(), body: z.json().optional() }),
});
const pact = z
	.object({
		consumer: z.object({ name: z.literal("HoboCiRepositoryOnboarding") }),
		provider: z.object({ name: z.literal("GithubAppRepositoryRestApi") }),
		metadata: z.object({
			pactSpecification: z.object({ version: z.literal("3.0.0") }),
			consumerFixtures: z.object({
				apiHeaders: z.record(z.string(), z.string()),
				principal: z.object({
					accountId: z.string(),
					installationIds: z.array(z.number()),
				}),
				options: z.object({
					principal: z.object({
						accountId: z.string(),
						installationIds: z.array(z.number()),
					}),
					installationId: z.number(),
					repository: z.string(),
					expectedRepositoryId: z.number(),
					relayUrl: z.string(),
					trustedRefs: z.array(z.string()),
					trustedRepositoryAcknowledged: z.boolean(),
					assets: z.object({ workflow: z.string(), bootstrap: z.string() }),
				}),
				plan: z.json(),
				manifest: z.json(),
				shas: z.object({
					base: z.string(),
					baseTree: z.string(),
					tree: z.string(),
					commit: z.string(),
					merged: z.string(),
				}),
			}),
		}),
		interactions: z.array(Interaction),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL("./onboarding-boundary.pact.json", import.meta.url),
				"utf8",
			),
		),
	);
const fixtures = pact.metadata.consumerFixtures;
const identity = [
	"read authenticated App identity",
	"read App installation permissions",
	"bind repository to selected installation",
	"read installed repository identity",
	"resolve App bot actor identity",
];
const installedFiles = [
	"verify installation .github/workflows/hobo-ci-host.yml",
	"verify installation .hobo-ci/bootstrap.mts",
];
const mergedFiles = [
	"verify merged .github/workflows/hobo-ci-host.yml",
	"verify merged .hobo-ci/bootstrap.mts",
];
const exercised = new Set<string>();
const verifyProviders: (() => void)[] = [];
function provider(descriptions: string[], track = true) {
	let count = 0;
	let unmatched = 0;
	async function send(
		scope: "app" | "installation",
		path: string,
		method: string,
		body?: string,
	) {
		const description = descriptions[count++];
		const fixture = pact.interactions.find(
			(item) => item.description === description,
		);
		if (!fixture) {
			unmatched++;
			throw new Error("PACT_NO_INTERACTION");
		}
		expect({
			scope,
			method,
			path,
			body: body === undefined ? undefined : JSON.parse(body),
		}).toEqual({
			...fixture.request,
			body: fixture.request.body,
		});
		if (track) exercised.add(fixture.description);
		return new Response(
			fixture.response.body === undefined
				? null
				: JSON.stringify(fixture.response.body),
			{ status: fixture.response.status },
		);
	}
	const github: OnboardingGithubPort = {
		appRequest: (path) => send("app", path, "GET"),
		request: (installationId, path, method = "GET", body) => {
			expect(installationId).toBe(fixtures.options.installationId);
			return send("installation", path, method, body);
		},
	};
	const result = {
		github,
		complete: () => expect(count).toBe(descriptions.length),
		countUnmatched: () => unmatched,
	};
	if (track)
		verifyProviders.push(() => {
			result.complete();
			expect(result.countUnmatched()).toBe(0);
		});
	return result;
}
afterAll(() => {
	expect([...exercised].sort()).toEqual(
		pact.interactions.map((item) => item.description).sort(),
	);
	for (const verify of verifyProviders) verify();
});

describe("GitHub App repository onboarding REST consumer contract", () => {
	it("executes the complete REST flow through signed App and installation transports", async () => {
		const subject = provider([
			...identity,
			"read reviewed default head",
			"read reviewed base tree",
			...identity,
			"installation branch absent",
			"read reviewed base tree",
			"create reviewed installation tree",
			"create reviewed installation commit",
			"create deterministic installation branch",
			"read deterministic installation branch",
			"verify installation parent commit",
			"verify only reviewed files changed",
			...installedFiles,
			"installation pull request absent",
			"create one reviewed installation pull request",
			...identity,
			"find merged installation pull request",
			"read merged default head",
			...mergedFiles,
			...mergedFiles,
			"bridge branch absent",
			"create immutable bridge branch",
			"verify exact bridge commit pin",
			"bridge protection absent",
			"lock and protect the reviewed bridge",
			"verify acknowledged immutable protection",
			"verify exact bridge commit pin",
		]);
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const exchange = pact.interactions.find(
			(item) =>
				item.description ===
				"exchange App JWT for onboarding installation token",
		);
		if (!exchange) throw new Error("missing token exchange contract");
		let exchanges = 0;
		const github = createGithubAppTransport({
			appId: "17",
			privateKey: privateKey
				.export({ type: "pkcs8", format: "pem" })
				.toString(),
			now: () => Date.parse("2026-10-27T00:00:00Z"),
			fetch: async (input, init) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("https://api.github.com");
				expect(init?.redirect).toBe("error");
				expect(init?.signal?.aborted).toBe(false);
				const headers = new Headers(init?.headers);
				for (const [key, value] of Object.entries(fixtures.apiHeaders))
					expect(headers.get(key)).toBe(value);
				const authorization = headers.get("authorization");
				expect(authorization?.startsWith("Bearer ")).toBe(true);
				if (authorization !== "Bearer fixture-installation-token") {
					const [header, payload, signature] =
						authorization?.slice("Bearer ".length).split(".") ?? [];
					if (!header || !payload || !signature)
						throw new Error("missing signed App identity");
					expect(
						JSON.parse(Buffer.from(header, "base64url").toString()),
					).toEqual({ alg: "RS256", typ: "JWT" });
					const issued = Date.parse("2026-10-27T00:00:00Z") / 1000 - 60;
					expect(
						JSON.parse(Buffer.from(payload, "base64url").toString()),
					).toEqual({ iat: issued, exp: issued + 600, iss: "17" });
					expect(
						verify(
							"RSA-SHA256",
							Buffer.from(`${header}.${payload}`),
							publicKey,
							Buffer.from(signature, "base64url"),
						),
					).toBe(true);
				}
				if (url.pathname === exchange.request.path) {
					exchanges++;
					expect(authorization).not.toBe("Bearer fixture-installation-token");
					expect(init?.method).toBe(exchange.request.method);
					expect(init?.body).toBeUndefined();
					exercised.add(exchange.description);
					return new Response(JSON.stringify(exchange.response.body), {
						status: exchange.response.status,
					});
				}
				const path = `${url.pathname}${url.search}`;
				return authorization === "Bearer fixture-installation-token"
					? subject.github.request(
							5,
							path,
							z.enum(["GET", "POST", "PUT"]).parse(init?.method),
							init?.body === undefined ? undefined : String(init.body),
						)
					: subject.github.appRequest(path);
			},
		});
		const prepared = await prepareOnboarding(github, fixtures.options);
		await applyOnboarding(github, fixtures.principal, prepared);
		expect(
			(await connectRepository(github, fixtures.principal, prepared)).bridgeSha,
		).toBe(fixtures.shas.merged);
		expect(exchanges).toBe(1);
	});
	it("emits the real GitHub manifest spelling, events and installation permissions", () => {
		const result = createGithubAppManifest({
			name: "HoBo CI",
			relayUrl: fixtures.options.relayUrl,
			manifestCallbackUrl: "https://ci.hobo.test/github/app/manifest/callback",
			installationCallbackUrl: "https://ci.hobo.test/github/app/installed",
		});
		expect(JSON.parse(githubAppManifestJson(result))).toEqual(
			fixtures.manifest,
		);
	});
	it("prepares immutable file intent and opens one ordinary setup PR without mutating default", async () => {
		const subject = provider([
			...identity,
			"read reviewed default head",
			"read reviewed base tree",
			...identity,
			"installation branch absent",
			"read reviewed base tree",
			"create reviewed installation tree",
			"create reviewed installation commit",
			"create deterministic installation branch",
			"read deterministic installation branch",
			"verify installation parent commit",
			"verify only reviewed files changed",
			...installedFiles,
			"installation pull request absent",
			"create one reviewed installation pull request",
		]);
		const plan = await prepareOnboarding(subject.github, fixtures.options);
		expect(JSON.parse(JSON.stringify(plan))).not.toHaveProperty("credentials");
		expect(plan.planDigest).toBe(
			parseOnboardingPlan(JSON.stringify(fixtures.plan)).planDigest,
		);
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.files[0])).toBe(true);
		const result = await applyOnboarding(
			subject.github,
			fixtures.principal,
			plan,
		);
		expect(result).toMatchObject({
			status: "pending",
			pullRequestNumber: 7,
			pullRequestUrl: "https://github.com/widget/repo/pull/7",
			commitSha: fixtures.shas.commit,
			planDigest: plan.planDigest,
		});
	});
	it("discovers a prior branch and PR instead of replaying their side effects", async () => {
		const subject = provider([
			...identity,
			"read deterministic installation branch",
			"verify installation parent commit",
			"verify only reviewed files changed",
			...installedFiles,
			"find existing installation pull request",
		]);
		const result = await applyOnboarding(
			subject.github,
			fixtures.principal,
			parseOnboardingPlan(JSON.stringify(fixtures.plan)),
		);
		expect(result.pullRequestNumber).toBe(7);
	});
	it("connects only after merge and verifies a locked, admin-enforced exact bridge commit", async () => {
		const subject = provider([
			...identity,
			"find merged installation pull request",
			"read merged default head",
			...mergedFiles,
			...mergedFiles,
			"bridge branch absent",
			"create immutable bridge branch",
			"verify exact bridge commit pin",
			"bridge protection absent",
			"lock and protect the reviewed bridge",
			"verify acknowledged immutable protection",
			"verify exact bridge commit pin",
		]);
		const plan = parseOnboardingPlan(JSON.stringify(fixtures.plan));
		const connection = await connectRepository(
			subject.github,
			fixtures.principal,
			plan,
		);
		expect(connection).toMatchObject({
			accountId: "tenant",
			installationId: 5,
			repositoryId: 42,
			repository: "widget/repo",
			dispatcherActorId: 77,
			bridgeRef: plan.bridgeRef,
			bridgeSha: fixtures.shas.merged,
			trustedRepositoryAcknowledged: true,
			publicRepositoryAcknowledged: false,
		});
	});
	it("reports pending before merge and creates no bridge or connection", async () => {
		const subject = provider([
			...identity,
			"find existing installation pull request",
		]);
		await expect(
			connectRepository(
				subject.github,
				fixtures.principal,
				parseOnboardingPlan(JSON.stringify(fixtures.plan)),
			),
		).rejects.toBeInstanceOf(OnboardingPendingError);
	});
	it("pins the contract provider with a negative control against unmatched calls", async () => {
		const negative = provider([], false);
		await expect(negative.github.appRequest("/unexpected")).rejects.toThrow(
			"PACT_NO_INTERACTION",
		);
		expect(negative.countUnmatched()).toBe(1);
	});
});
