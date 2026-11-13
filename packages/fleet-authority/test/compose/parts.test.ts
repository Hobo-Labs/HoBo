import { create } from "@bufbuild/protobuf";
import { type PolicyRequest, parseTenantId } from "@hobo/core";
import {
	FleetMemberViewSchema,
	FleetRecordSchema,
	FleetViewSchema,
	MemberKind,
	MemberRecordSchema,
	MemberState,
	parseFleetId,
	parseMemberId,
	type RegistryView,
	Role,
	SignedEnvelopeSchema,
	TrustRecordSchema,
	WorkOfferSchema,
} from "@hobo/fleet";
import { workDigest } from "@hobo/fleet/work";
import { describe, expect, it } from "vitest";
import {
	rankedFromView,
	withProjectionRanking,
} from "../../src/compose/ranking.js";
import { pollRegistryChanges } from "../../src/compose/registry-changes.js";
import {
	createAccountVerifier,
	parsePrincipal,
} from "../../src/identity/accounts.js";
import { createPolicyDecisionRecorder } from "../../src/identity/decisions.js";
import {
	combineDirectories,
	createClaimPrincipalDirectory,
	createStaticPrincipalDirectory,
} from "../../src/identity/directory.js";
import { createTagPolicyEngine } from "../../src/identity/policy.js";
import { createHarness } from "../support/harness.js";

const tenant = parseTenantId("acme");
const request = (action: string, tags: readonly string[]): PolicyRequest => ({
	subject: { identity: "user:alice", tenantId: tenant, tags },
	action,
	resource: { kind: "fleet", id: "build", tenantId: tenant },
});

describe("the tag policy engine", () => {
	it("allows fleet-admin, the action's own tag and configured grants, and denies the rest", async () => {
		const engine = createTagPolicyEngine();
		expect(
			(await engine.evaluate(request("fleet.member.suspend", ["fleet-admin"])))
				.effect,
		).toBe("allow");
		expect(
			(
				await engine.evaluate(
					request("fleet.member.suspend", ["fleet.member.suspend"]),
				)
			).effect,
		).toBe("allow");
		expect(
			(
				await engine.evaluate(
					request("fleet.member.declare", [`role:${Role.DISPATCHER}`]),
				)
			).effect,
		).toBe("allow");
		expect(
			(
				await engine.evaluate(
					request("fleet.member.suspend", [`role:${Role.DISPATCHER}`]),
				)
			).effect,
		).toBe("deny");
		expect(
			(await engine.evaluate(request("fleet.member.suspend", []))).effect,
		).toBe("deny");
	});

	it("records each decision as one policy.Decided event with the input's hash", async () => {
		const engine = createTagPolicyEngine();
		const input = request("fleet.member.suspend", []);
		const event = createPolicyDecisionRecorder().toEvent(
			input,
			await engine.evaluate(input),
		);
		expect(event).toMatchObject({
			type: "policy.Decided",
			data: {
				action: "fleet.member.suspend",
				effect: "deny",
				engineId: "hobo-fleet-authority/tags/v1",
				resourceId: "build",
			},
		});
		expect(JSON.stringify(event.data)).toMatch(/"inputHash":"sha256:[0-9a-f]{64}"/u);
	});
});

describe("principals and accounts", () => {
	it("maps static entries, aliases and claim rules, merged per tenant", async () => {
		const directory = combineDirectories([
			createStaticPrincipalDirectory([
				{
					principal: "user:github.com/octo",
					tenant: "acme",
					tags: ["auditor"],
					aliases: ["user:login.example/octo@example.com"],
				},
			]),
			createClaimPrincipalDirectory([
				{ tenant: "acme", claim: "org", equals: "acme", tags: ["fleet-admin"] },
			]),
		]);
		expect(
			await directory.tenantsOf(
				{ kind: "user", id: "github.com/octo" },
				{ org: "hobo,acme" },
			),
		).toEqual([
			{
				tenant: "acme",
				tags: ["auditor", "fleet-admin"],
				aliases: ["user:login.example/octo@example.com"],
			},
		]);
		expect(
			await directory.tenantsOf(
				{ kind: "user", id: "login.example/octo@example.com" },
				{},
			),
		).toEqual([{ tenant: "acme", tags: ["auditor"], aliases: [] }]);
		expect(
			await directory.tenantsOf(
				{ kind: "user", id: "mallory" },
				{ org: "acmex" },
			),
		).toEqual([]);
	});

	it("verifies only a configured account credential of adequate length", async () => {
		const verifier = createAccountVerifier(tenant, [
			{
				principal: { kind: "service", id: "ci-relay" },
				scopes: ["fleet.read"],
				credential: "c".repeat(40),
			},
			{
				principal: { kind: "service", id: "weak" },
				scopes: [],
				credential: "short",
			},
		]);
		expect((await verifier.verify("c".repeat(40))).ok).toBe(true);
		expect((await verifier.verify("short")).ok).toBe(false);
		expect((await verifier.verify("c".repeat(41))).ok).toBe(false);
		expect(parsePrincipal("service:ci-relay")).toEqual({
			kind: "service",
			id: "ci-relay",
		});
		expect(parsePrincipal("robot:x")).toBeUndefined();
	});
});

describe("the projection's ranking for reports (D59)", () => {
	const executor = (id: string, slots: number) =>
		create(FleetMemberViewSchema, {
			memberId: id,
			kind: MemberKind.DEVICE,
			state: MemberState.ACTIVE,
			roles: [Role.EXECUTOR],
			capacity: { freeSlots: slots },
		});
	const a = `dev_${"a".repeat(32)}`;
	const b = `dev_${"b".repeat(32)}`;
	const view = create(FleetViewSchema, {
		fleet: "build",
		members: [
			executor(a, 2),
			executor(b, 1),
			create(FleetMemberViewSchema, {
				memberId: `dev_${"c".repeat(32)}`,
				kind: MemberKind.DEVICE,
				state: MemberState.SUSPENDED,
				roles: [Role.EXECUTOR],
			}),
		],
	});

	it("ranks the view's active executors and leaves others out", () => {
		const ranked = rankedFromView(view, workDigest("oci-command", "job-1"));
		expect([...ranked].sort()).toEqual([a, b]);
	});

	it("substitutes the ranking only when the caller passed none", async () => {
		const seen: (readonly string[])[] = [];
		const registry: Pick<RegistryView, "view"> = { view: async () => view };
		const check = withProjectionRanking(
			async (_claim, _subject, _offer, context) => {
				seen.push(context.ranked);
				return "valid";
			},
			// SAFETY: the ranking reads only `view`; the rest of the registry is never called.
			() => registry as RegistryView,
		);
		const digest = workDigest("oci-command", "job-1");
		const subject = { fleet: parseFleetId("build"), digest };
		const context = {
			// SAFETY: the double's checker reads no registry.
			registry: registry as RegistryView,
			nowMs: 0,
			stepMs: 20_000,
		};
		const offer = create(WorkOfferSchema, { fleet: "build" });
		const claim = create(SignedEnvelopeSchema);
		await check(claim, subject, offer, { ...context, ranked: [] });
		await check(claim, subject, offer, {
			...context,
			ranked: [parseMemberId(b)],
		});
		expect(seen[0]).toHaveLength(2);
		expect(seen[1]).toEqual([b]);
	});
});

describe("the witness's registry changes", () => {
	it("reports each key once per new record sequence and ignores re-signs", async () => {
		let revision = 1;
		const registry: Pick<RegistryView, "trust" | "fleets" | "members"> = {
			trust: () => create(TrustRecordSchema, { sequence: 2 }),
			fleets: async () => [
				create(FleetRecordSchema, { fleetId: "build", revision }),
			],
			members: async () => [
				create(MemberRecordSchema, {
					memberId: `dev_${"a".repeat(32)}`,
					recordSequence: 5,
				}),
			],
		};
		const seen: string[] = [];
		// SAFETY: the source reads only trust, fleets and members.
		const subscribe = pollRegistryChanges(registry as RegistryView, 5);
		const subscription = subscribe(async (key, sequence) => {
			seen.push(`${key}@${sequence}`);
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		revision = 2;
		await new Promise((resolve) => setTimeout(resolve, 30));
		await subscription.stop();
		expect(seen).toEqual([
			"trust@2",
			"fleet.build@1",
			`member.dev_${"a".repeat(32)}@5`,
			"fleet.build@2",
		]);
	});
});

describe("the service's own bookkeeping", () => {
	it("is not ready until the projection has caught up, and records every API request", async () => {
		const h = await createHarness();
		expect((await h.send("GET", "/healthz")).status).toBe(200);
		expect((await h.send("GET", "/readyz")).status).toBe(200);
		await h.send("GET", "/.well-known/hobo-fleet");
		await h.send("GET", "/v1/fleet/members");
		h.time.advance(120_000);
		await h.runtime.status.tick();
		const measured = [];
		for await (const positioned of h.test.store.readAll())
			if (
				JSON.stringify(positioned.event.data).includes("fleet-enrollment-api")
			)
				measured.push(positioned.event.data);
		expect(measured).toContainEqual(
			expect.objectContaining({
				componentId: "fleet-enrollment-api",
				attainment: 1,
			}),
		);
		await h.runtime.stop();
		expect((await h.send("GET", "/readyz")).status).toBe(503);
	});

	it("answers unknown routes, wrong methods, oversized bodies and bad JSON with FleetErrors", async () => {
		const h = await createHarness();
		expect((await h.send("GET", "/v1/fleet/nowhere")).status).toBe(404);
		expect((await h.send("DELETE", "/v1/fleet/fleets")).status).toBe(405);
		const big = await h.send("POST", "/v1/fleet/signin/start", {
			body: "x".repeat(300_000),
		});
		expect(big.status).toBe(413);
		const bad = await h.send("POST", "/v1/fleet/signin/start", {
			body: "{not json",
		});
		expect(bad.json()).toMatchObject({ code: "invalid-request" });
		const unknown = await h.send("POST", "/v1/fleet/signin/start", {
			body: JSON.stringify({ provider: "test", extra: 1 }),
		});
		expect(unknown.json()).toMatchObject({ code: "invalid-request" });
	});
});
