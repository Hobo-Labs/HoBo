import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	AccountSchema,
	AccountStateSchema,
	ConnectionSchema,
	JobSchema,
	OfferSchema,
	SnapshotSchema,
} from "@hobo/ci";
import { afterEach, describe, expect, it } from "vitest";
import { createControlAuthenticator } from "../src/control-auth.js";
import {
	OnboardingOperationSchema,
	OnboardingPrincipalSchema,
} from "../src/onboarding.js";
import {
	APPLY_CALLS,
	CONNECT_CALLS,
	controlHttp,
	credentials,
	IDENTITY_CALLS,
	initialConfiguration,
	OPERATOR_TOKEN,
	OTHER_TOKEN,
	PREPARE_CALLS,
	READ_TOKEN,
	REPOSITORY_TOKEN,
	SETUP_PLAN,
	strictGithub,
	TOKEN,
} from "./fixtures/control-api-github.js";
import { harness, reserve } from "./fixtures.js";

const running: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of running.splice(0).reverse()) await stop();
});
async function setup(options: Parameters<typeof controlHttp>[0] = {}) {
	const http = await controlHttp(options);
	running.push(http.stop);
	return http;
}
function headers(token = TOKEN, revision?: number) {
	const result = new Headers({
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	});
	if (revision !== undefined) result.set("If-Match", `"${revision}"`);
	return result;
}
function account(id = "tenant", budgetMicros = 1_000_000) {
	return { id, budgetMicros, maxRuntimeMinutes: 9, startupMinutes: 1 };
}
const setupRequest = {
	repository: "widget/repo",
	repositoryId: 42,
	installationId: 5,
	allowedRefs: ["refs/heads/main"],
	trustedRepositoryAcknowledged: true,
};
const root = "/v1/accounts/self";

describe("authenticated account control plane over actual HTTP", () => {
	it("authenticates SHA256 bindings at every credential position and freezes server-owned scope bindings", async () => {
		const authenticate = createControlAuthenticator(credentials());
		for (const token of [TOKEN, READ_TOKEN, REPOSITORY_TOKEN, OPERATOR_TOKEN]) {
			const principal = await authenticate(`Bearer ${token}`);
			expect(principal?.accountId).toBe("tenant");
			expect(Object.isFrozen(principal)).toBe(true);
			expect(Object.isFrozen(principal?.installationIds)).toBe(true);
			expect(Object.isFrozen(principal?.scopes)).toBe(true);
		}
		expect((await authenticate(`Bearer ${OTHER_TOKEN}`))?.accountId).toBe(
			"neighbor",
		);
		for (const value of [
			undefined,
			"",
			`Basic ${TOKEN}`,
			"Bearer short",
			`Bearer ${"z".repeat(64)}`,
		])
			expect(await authenticate(value)).toBeUndefined();
		expect(credentials()).not.toContain(TOKEN);
	});
	it("rejects token hash reuse, unknown scopes and cross-account installation bindings", () => {
		const digest = createHash("sha256").update(TOKEN).digest("hex");
		const first = {
			accountId: "tenant",
			installationIds: [5],
			tokenSha256: digest,
			scopes: ["policy:read"],
		};
		expect(() =>
			createControlAuthenticator(JSON.stringify({ tokens: [first, first] })),
		).toThrow();
		expect(() =>
			createControlAuthenticator(
				JSON.stringify({
					tokens: [{ ...first, scopes: ["admin:everything"] }],
				}),
			),
		).toThrow();
		expect(() =>
			createControlAuthenticator(
				JSON.stringify({
					tokens: [
						first,
						{ ...first, accountId: "neighbor", tokenSha256: "b".repeat(64) },
					],
				}),
			),
		).toThrow();
	});
	it("returns account-only policy and lease snapshots, and refuses absent credentials and missing write scope", async () => {
		const github = strictGithub([]);
		const h = await setup({ github: github.github });
		for (const authorization of [
			undefined,
			"Bearer invalid-token-at-least-32-characters",
		]) {
			const response = await fetch(
				`${h.base}${root}/policy`,
				authorization ? { headers: { Authorization: authorization } } : {},
			);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({
				error: "account authentication required",
			});
		}
		for (const [token, id, budget] of [
			[TOKEN, "tenant", 1_000_000],
			[OTHER_TOKEN, "neighbor", 2_000_000],
		] as const) {
			const response = await fetch(`${h.base}${root}/policy`, {
				headers: headers(token),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("etag")).toBe('"1"');
			expect(response.headers.get("cache-control")).toBe("no-store");
			const result = fromJsonString(AccountStateSchema, await response.text());
			expect(result.account?.id).toBe(id);
			expect(result.account?.budgetMicros).toBe(budget);
			expect(result.connections).toEqual([]);
		}
		const denied = await fetch(`${h.base}${root}/policy`, {
			method: "PUT",
			headers: headers(READ_TOKEN, 1),
			body: JSON.stringify(account()),
		});
		expect(denied.status).toBe(403);
		const snapshot = await fetch(`${h.base}${root}/leases`, {
			headers: headers(),
		});
		expect(
			fromJsonString(SnapshotSchema, await snapshot.text()).leases,
		).toEqual([]);
		github.assertComplete();
	});
	it("validates protobuf JSON and If-Match without changing policy on refusal", async () => {
		const h = await setup();
		const cases = [
			{ body: JSON.stringify(account()), revision: undefined, status: 428 },
			{ body: JSON.stringify(account("neighbor")), revision: 1, status: 403 },
			{
				body: JSON.stringify({ ...account(), arbitraryPlan: true }),
				revision: 1,
				status: 400,
			},
			{ body: JSON.stringify(account("tenant", -1)), revision: 1, status: 400 },
			{ body: "{", revision: 1, status: 400 },
		];
		for (const test of cases) {
			const response = await fetch(`${h.base}${root}/policy`, {
				method: "PUT",
				headers: headers(TOKEN, test.revision),
				body: test.body,
			});
			expect(response.status).toBe(test.status);
			expect(h.store.configuration()?.revision).toBe(1);
		}
		expect(h.store.events()).toHaveLength(1);
	});
	it("returns a bounded 413 response for oversized authenticated policy input without committing it", async () => {
		const h = await setup();
		const response = await fetch(`${h.base}${root}/policy`, {
			method: "PUT",
			headers: headers(TOKEN, 1),
			body: " ".repeat(1024 * 1024 + 1),
			signal: AbortSignal.timeout(3000),
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "request body too large" });
		expect(h.store.configuration()?.revision).toBe(1);
	});
	it("allows exactly one concurrent policy CAS, then preserves both tenants on a fresh retry", async () => {
		const h = await setup();
		const attempted = [
			account("tenant", 1_000_100),
			account("neighbor", 2_000_200),
		];
		const results = await Promise.all(
			attempted.map((entry, index) =>
				fetch(`${h.base}${root}/policy`, {
					method: "PUT",
					headers: headers(index === 0 ? TOKEN : OTHER_TOKEN, 1),
					body: JSON.stringify(entry),
				}),
			),
		);
		expect(results.map((response) => response.status).sort()).toEqual([
			200, 409,
		]);
		const loser = results.findIndex((response) => response.status === 409);
		const retry = await fetch(`${h.base}${root}/policy`, {
			method: "PUT",
			headers: headers(loser === 0 ? TOKEN : OTHER_TOKEN, 2),
			body: JSON.stringify(attempted[loser]),
		});
		expect(retry.status).toBe(200);
		const saved = h.store.configuration();
		expect(saved?.revision).toBe(3);
		expect(
			saved?.configuration?.accounts
				.map((entry) => [entry.id, entry.budgetMicros])
				.sort(),
		).toEqual([
			["neighbor", 2_000_200],
			["tenant", 1_000_100],
		]);
		// The relay reads its policy from the store on every operation.
		expect((await h.ledger.configuration())?.configuration).toEqual(
			saved?.configuration,
		);
	});
	it("re-reads other tenant policy after a delayed request body rather than committing a stale snapshot", async () => {
		const h = await setup();
		let finish = () => {};
		let began = () => {};
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const delayed = new Promise<number>((resolve, reject) => {
			const pending = request(
				`${h.base}${root}/policy`,
				{
					method: "PUT",
					headers: {
						Authorization: `Bearer ${TOKEN}`,
						"Content-Type": "application/json",
						"If-Match": '"2"',
						Expect: "100-continue",
					},
				},
				(response) => {
					response.resume();
					response.once("end", () => resolve(response.statusCode ?? 0));
				},
			);
			pending.once("error", reject);
			pending.once("continue", () => {
				pending.write('{"id":"tenant",');
				began();
			});
			finish = () =>
				pending.end(
					'"budgetMicros":1000100,"maxRuntimeMinutes":9,"startupMinutes":1}',
				);
			pending.flushHeaders();
		});
		await started;
		try {
			expect(
				(
					await fetch(`${h.base}${root}/policy`, {
						method: "PUT",
						headers: headers(OTHER_TOKEN, 1),
						body: JSON.stringify(account("neighbor", 2_000_200)),
					})
				).status,
			).toBe(200);
		} finally {
			finish();
		}
		expect(await delayed).toBe(200);
		expect(
			h.store
				.configuration()
				?.configuration?.accounts.map((entry) => [entry.id, entry.budgetMicros])
				.sort(),
		).toEqual([
			["neighbor", 2_000_200],
			["tenant", 1_000_100],
		]);
	});
	it("rejects unbound installations, untrusted setup and unknown client fields before GitHub", async () => {
		const github = strictGithub([]);
		const h = await setup({ github: github.github });
		for (const [body, status] of [
			[{ ...setupRequest, installationId: 6 }, 403],
			[{ ...setupRequest, trustedRepositoryAcknowledged: false }, 400],
			[
				{ ...setupRequest, files: [{ path: "malicious", content: "code" }] },
				400,
			],
		] as const)
			expect(
				(
					await fetch(`${h.base}${root}/repositories/prepare`, {
						method: "POST",
						headers: headers(),
						body: JSON.stringify(body),
					})
				).status,
			).toBe(status);
		github.assertComplete();
	});
	it("discovers a name-only setup from the one bound installation and keeps chooser identities account-local", async () => {
		const github = strictGithub([
			"read installed repository identity",
			...PREPARE_CALLS,
		]);
		const h = await setup({ github: github.github });
		for (const [token, accountId, installationIds] of [
			[TOKEN, "tenant", [5]],
			[OTHER_TOKEN, "neighbor", [6]],
		] as const) {
			const response = await fetch(`${h.base}${root}/installations`, {
				headers: headers(token),
			});
			expect(response.status).toBe(200);
			const principal = fromJsonString(
				OnboardingPrincipalSchema,
				await response.text(),
			);
			expect(principal.accountId).toBe(accountId);
			expect(principal.installationIds).toEqual(installationIds);
		}
		const prepared = await fetch(`${h.base}${root}/repositories/prepare`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				repository: "widget/repo",
				trustedRepositoryAcknowledged: true,
			}),
		});
		expect(prepared.status).toBe(201);
		expect(
			fromJsonString(OnboardingOperationSchema, await prepared.text()).plan,
		).toEqual(SETUP_PLAN);
		github.assertComplete();
	});
	it("requires an explicit choice when the authenticated account owns multiple installations", async () => {
		const github = strictGithub([]);
		const credentialJson = JSON.stringify({
			tokens: [
				{
					accountId: "tenant",
					installationIds: [5, 7],
					tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
					scopes: ["policy:read", "repositories:write"],
				},
			],
		});
		const h = await setup({ github: github.github, credentialJson });
		const installations = await fetch(`${h.base}${root}/installations`, {
			headers: headers(),
		});
		expect(
			fromJsonString(OnboardingPrincipalSchema, await installations.text())
				.installationIds,
		).toEqual([5, 7]);
		const prepared = await fetch(`${h.base}${root}/repositories/prepare`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				repository: "widget/repo",
				trustedRepositoryAcknowledged: true,
			}),
		});
		expect(prepared.status).toBe(400);
		github.assertComplete();
	});
	it("refuses explicitly identified and name-only repositories owned by another account before any provider lookup", async () => {
		const github = strictGithub([]);
		const configuration = initialConfiguration();
		configuration.connections.push(
			create(ConnectionSchema, {
				accountId: "neighbor",
				repository: "widget/repo",
				repositoryId: 42,
				installationId: 6,
				bridgeWorkflow: "host.yml",
				bridgeSha: "a".repeat(40),
				runnerGroupId: 1,
				allowedEvents: ["push"],
				allowedRefs: ["refs/heads/main"],
				trustedRepositoryAcknowledged: true,
				bridgeRef: "reviewed",
				dispatcherActorId: 77,
				publicRepositoryAcknowledged: false,
			}),
		);
		const h = await setup({ github: github.github, configuration });
		for (const request of [
			setupRequest,
			{ repository: "widget/repo", trustedRepositoryAcknowledged: true },
		]) {
			const response = await fetch(`${h.base}${root}/repositories/prepare`, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(request),
			});
			expect(response.status).toBe(409);
		}
		github.assertComplete();
	});
	it("installs through a stored-plan setup PR and connects only verified protected source, with durable replay", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-control-api-"));
		const github = strictGithub([
			...PREPARE_CALLS,
			...APPLY_CALLS,
			...CONNECT_CALLS,
		]);
		const path = join(directory, "control.sqlite");
		const h = await setup({ path, github: github.github });
		let reopened: Awaited<ReturnType<typeof setup>> | undefined;
		try {
			const prepared = await fetch(`${h.base}${root}/repositories/prepare`, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(setupRequest),
			});
			expect(prepared.status).toBe(201);
			const operation = fromJsonString(
				OnboardingOperationSchema,
				await prepared.text(),
			);
			expect(operation.id).toMatch(/^[a-f0-9-]{36}$/);
			expect(operation.plan).toEqual(SETUP_PLAN);
			const route = `${root}/repositories/${operation.id}`;
			expect(
				h.store.controlRecord(`onboarding:${operation.id}`)?.accountId,
			).toBe("tenant");
			expect(
				(await fetch(`${h.base}${route}`, { headers: headers(OTHER_TOKEN) }))
					.status,
			).toBe(404);
			expect(
				(
					await fetch(`${h.base}${route}/apply`, {
						method: "POST",
						headers: headers(),
						body: JSON.stringify({ plan: SETUP_PLAN }),
					})
				).status,
			).toBe(400);
			expect(github.count()).toBe(PREPARE_CALLS.length);
			const applied = await fetch(`${h.base}${route}/apply`, {
				method: "POST",
				headers: headers(),
			});
			expect(applied.status).toBe(202);
			expect(
				fromJsonString(OnboardingOperationSchema, await applied.text()),
			).toMatchObject({
				id: operation.id,
				status: "pending",
				result: { pullRequestUrl: "https://github.com/widget/repo/pull/7" },
			});
			expect(h.store.configuration()?.configuration?.connections).toEqual([]);
			for (const [revision, expected] of [
				[undefined, 428],
				[0, 409],
			] as const)
				expect(
					(
						await fetch(`${h.base}${route}/connect`, {
							method: "POST",
							headers: headers(TOKEN, revision),
						})
					).status,
				).toBe(expected);
			expect(github.count()).toBe(PREPARE_CALLS.length + APPLY_CALLS.length);
			const connected = await fetch(`${h.base}${route}/connect`, {
				method: "POST",
				headers: headers(TOKEN, 1),
			});
			expect(connected.status).toBe(200);
			expect(connected.headers.get("etag")).toBe('"2"');
			const ready = fromJsonString(
				OnboardingOperationSchema,
				await connected.text(),
			);
			expect(ready.status).toBe("ready");
			expect(
				(await h.ledger.configuration())?.configuration?.connections[0],
			).toMatchObject({
				accountId: "tenant",
				repositoryId: 42,
				bridgeSha: "7".repeat(40),
				bridgeRef: SETUP_PLAN.bridgeRef,
			});
			const repeated = await fetch(`${h.base}${route}/apply`, {
				method: "POST",
				headers: headers(),
			});
			expect(repeated.status).toBe(200);
			expect(
				fromJsonString(OnboardingOperationSchema, await repeated.text()).status,
			).toBe("ready");
			github.assertComplete();
			await h.stop();
			const offline = strictGithub([]);
			reopened = await setup({ path, github: offline.github });
			const previousEvents = reopened.store.events().length;
			reopened.store.rebuild();
			expect(reopened.store.events()).toHaveLength(previousEvents);
			const persisted = await fetch(`${reopened.base}${route}`, {
				headers: headers(),
			});
			expect(
				fromJsonString(OnboardingOperationSchema, await persisted.text()),
			).toEqual(ready);
			expect(
				reopened.store.configuration()?.configuration?.connections[0]
					?.bridgeSha,
			).toBe("7".repeat(40));
			const replay = await fetch(`${reopened.base}${route}/apply`, {
				method: "POST",
				headers: headers(),
			});
			expect(replay.status).toBe(200);
			expect(
				fromJsonString(OnboardingOperationSchema, await replay.text()).status,
			).toBe("ready");
			offline.assertComplete();
			expect(JSON.stringify(reopened.store.events())).not.toContain(TOKEN);
		} finally {
			await reopened?.stop();
			await h.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("repairs a configuration-committed operation after a crash while preserving an active lease and refusing a different bridge", async () => {
		const github = strictGithub([
			...PREPARE_CALLS,
			...PREPARE_CALLS,
			...APPLY_CALLS,
			...CONNECT_CALLS,
		]);
		const configuration = initialConfiguration();
		const policy = configuration.accounts.find(
			(entry) => entry.id === "tenant",
		);
		if (!policy) throw new Error("missing tenant policy");
		policy.offers.push(
			create(OfferSchema, {
				id: "github-owned",
				provider: "github",
				providerAccountId: "owned-github-tenant",
				enabled: true,
				runsOn: "ubuntu-24.04",
				freeMinutes: 100,
				priceMicrosPerMinute: 1000,
				budgetMicros: 1_000_000,
				concurrency: 1,
				observedAt: "2026-10-27T00:00:00Z",
				validUntil: "2026-10-28T00:00:00Z",
				sourceUrl: "https://example.test/account-usage",
				bridgeAcknowledged: true,
			}),
		);
		const h = await setup({ github: github.github, configuration });
		const prepared = await fetch(`${h.base}${root}/repositories/prepare`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(setupRequest),
		});
		const operation = fromJsonString(
			OnboardingOperationSchema,
			await prepared.text(),
		);
		const another = await fetch(`${h.base}${root}/repositories/prepare`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				...setupRequest,
				allowedRefs: ["refs/heads/release"],
			}),
		});
		expect(another.status).toBe(201);
		const different = fromJsonString(
			OnboardingOperationSchema,
			await another.text(),
		);
		expect(different.plan?.bridgeRef).not.toBe(operation.plan?.bridgeRef);
		const route = `${h.base}${root}/repositories/${operation.id}`;
		expect(
			(await fetch(`${route}/apply`, { method: "POST", headers: headers() }))
				.status,
		).toBe(202);
		const connected = await fetch(`${route}/connect`, {
			method: "POST",
			headers: headers(TOKEN, 1),
		});
		expect(connected.status).toBe(200);
		const ready = fromJsonString(
			OnboardingOperationSchema,
			await connected.text(),
		);
		expect(ready.status).toBe("ready");
		const verified = h.store.configuration();
		expect(verified?.revision).toBe(2);
		expect(verified?.configuration?.connections[0]?.bridgeSha).toBe(
			"7".repeat(40),
		);
		// Recreate the cut after the verified configuration commit and before the ready-record commit.
		const interrupted = structuredClone(ready);
		interrupted.status = "pending";
		h.store.putControlRecord(
			`onboarding:${operation.id}`,
			"tenant",
			toJsonString(OnboardingOperationSchema, interrupted),
			h.relay.now(),
		);
		const tenant = verified?.configuration?.accounts.find(
			(entry) => entry.id === "tenant",
		);
		if (!tenant) throw new Error("missing persisted tenant policy");
		const lease = h.store.reserve(
			tenant,
			create(JobSchema, {
				id: 901,
				runId: 901,
				runAttempt: 1,
				repositoryId: 42,
				installationId: 5,
				repository: "widget/repo",
				labels: ["hobo"],
				action: "queued",
			}),
			h.relay.now(),
		);
		expect(lease?.state).toBe("reserved");
		const beforeRecovery = github.count();
		const recovered = await fetch(`${route}/connect`, {
			method: "POST",
			headers: headers(TOKEN, 2),
		});
		expect(recovered.status).toBe(200);
		expect(recovered.headers.get("etag")).toBe('"2"');
		expect(
			fromJsonString(OnboardingOperationSchema, await recovered.text()).status,
		).toBe("ready");
		expect(h.store.configuration()).toEqual(verified);
		expect(github.count()).toBe(beforeRecovery);
		expect(h.store.get(lease?.id ?? "")?.state).toBe("reserved");
		const beforeDenied = github.count();
		const denied = await fetch(
			`${h.base}${root}/repositories/${different.id}/connect`,
			{ method: "POST", headers: headers(TOKEN, 2) },
		);
		expect(denied.status).toBe(409);
		expect(github.count()).toBe(beforeDenied);
		expect(h.store.configuration()).toEqual(verified);
		github.assertComplete();
	});
	it("journals an uncertain apply without leaking provider errors and permits safe same-plan recovery", async () => {
		const github = strictGithub(
			[...PREPARE_CALLS, IDENTITY_CALLS[0] ?? "", ...APPLY_CALLS],
			new Map([
				[
					PREPARE_CALLS.length,
					{
						status: 503,
						body: { message: "Bearer provider-secret-do-not-leak" },
					},
				],
			]),
		);
		const h = await setup({ github: github.github });
		const prepared = await fetch(`${h.base}${root}/repositories/prepare`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(setupRequest),
		});
		const operation = fromJsonString(
			OnboardingOperationSchema,
			await prepared.text(),
		);
		const route = `${h.base}${root}/repositories/${operation.id}/apply`;
		const uncertain = await fetch(route, {
			method: "POST",
			headers: headers(),
		});
		expect(uncertain.status).toBe(503);
		expect(await uncertain.text()).not.toContain("provider-secret");
		const record = h.store.controlRecord(`onboarding:${operation.id}`);
		expect(
			fromJsonString(OnboardingOperationSchema, record?.bodyJson ?? "{}")
				.status,
		).toBe("uncertain");
		expect(
			(await fetch(route, { method: "POST", headers: headers() })).status,
		).toBe(202);
		expect(JSON.stringify(h.store.events())).not.toContain("provider-secret");
		github.assertComplete();
	});
	it.each([
		"success",
		"failure",
	])("retains ready when an earlier apply returns late with %s", async (outcome) => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail =
			outcome === "success"
				? [
						...IDENTITY_CALLS.slice(1),
						"read deterministic installation branch",
						"verify installation parent commit",
						"verify only reviewed files changed",
						"verify installation .github/workflows/hobo-ci-host.yml",
						"verify installation .hobo-ci/bootstrap.mts",
						"find merged installation pull request",
					]
				: [];
		const responses = new Map<
			number,
			{ status: number; body: { message: string } }
		>();
		if (outcome === "failure")
			responses.set(PREPARE_CALLS.length, {
				status: 503,
				body: { message: "late upstream failure" },
			});
		const github = strictGithub(
			[...PREPARE_CALLS, IDENTITY_CALLS[0] ?? "", ...CONNECT_CALLS, ...tail],
			responses,
			new Map([[PREPARE_CALLS.length, gate]]),
		);
		const h = await setup({ github: github.github });
		const prepared = await fetch(`${h.base}${root}/repositories/prepare`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(setupRequest),
		});
		const operation = fromJsonString(
			OnboardingOperationSchema,
			await prepared.text(),
		);
		const route = `${h.base}${root}/repositories/${operation.id}`;
		const late = fetch(`${route}/apply`, {
			method: "POST",
			headers: headers(),
		});
		try {
			await expect.poll(() => github.count()).toBe(PREPARE_CALLS.length + 1);
			const connected = await fetch(`${route}/connect`, {
				method: "POST",
				headers: headers(TOKEN, 1),
			});
			expect(connected.status).toBe(200);
			expect(
				fromJsonString(OnboardingOperationSchema, await connected.text())
					.status,
			).toBe("ready");
		} finally {
			release();
		}
		const resumed = await late;
		expect(resumed.status).toBe(200);
		expect(
			fromJsonString(OnboardingOperationSchema, await resumed.text()).status,
		).toBe("ready");
		expect(
			fromJsonString(
				OnboardingOperationSchema,
				h.store.controlRecord(`onboarding:${operation.id}`)?.bodyJson ?? "{}",
			).status,
		).toBe("ready");
		github.assertComplete();
	});
	it("checks lease ownership before reconciliation network and allows only the owning operator", async () => {
		const h = harness();
		const configuration = h.configuration;
		configuration.accounts.push(
			create(AccountSchema, {
				id: "account-b",
				maxRuntimeMinutes: 9,
				startupMinutes: 1,
			}),
		);
		h.store.configure(configuration, 0, h.clock.now);
		const lease = await reserve(h);
		const network: string[] = [];
		h.relay.options.github = {
			request: (id, path, method, body) => {
				network.push(path);
				return h.api.request(id, path, method, body);
			},
		};
		const credentialJson = JSON.stringify({
			tokens: [
				{
					accountId: "account-a",
					installationIds: [10],
					tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
					scopes: ["policy:read", "operations:write"],
				},
				{
					accountId: "account-b",
					installationIds: [20],
					tokenSha256: createHash("sha256").update(OTHER_TOKEN).digest("hex"),
					scopes: ["policy:read", "operations:write"],
				},
			],
		});
		const github = strictGithub([]);
		const http = await setup({
			relay: h,
			github: github.github,
			credentialJson,
		});
		const route = `${http.base}${root}/leases/${lease.id}`;
		expect((await fetch(route, { headers: headers(OTHER_TOKEN) })).status).toBe(
			404,
		);
		expect(
			(
				await fetch(`${route}/reconcile`, {
					method: "POST",
					headers: headers(OTHER_TOKEN),
					body: '{"hostRunId":22}',
				})
			).status,
		).toBe(404);
		expect(network).toEqual([]);
		const foreign = await fetch(`${http.base}${root}/leases`, {
			headers: headers(OTHER_TOKEN),
		});
		expect(fromJsonString(SnapshotSchema, await foreign.text()).leases).toEqual(
			[],
		);
		h.api.host.status = "completed";
		const own = await fetch(`${route}/reconcile`, {
			method: "POST",
			headers: headers(),
			body: '{"hostRunId":22}',
		});
		expect(own.status).toBe(200);
		expect(network).toContain("/repos/org/repo/actions/runs/22");
		expect(h.store.get(lease.id)?.state).toBe("completed");
		expect(h.api.violations).toEqual([]);
		github.assertComplete();
	});
});
