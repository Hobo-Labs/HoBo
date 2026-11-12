/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: tests read controlled journal JSON and pass deliberately invalid actions. */
// WP19 Accept: "An unauthorized action is refused with a recorded decision",
// §10 "Agent principal applies directly → Proposal only", I10 (every mutation
// has a recorded decision; agents propose by default), R14 separation of
// duties for the two enrollment grants, and one rule per CdAction.
import {
	createPermissiveDefaultPack,
	definePolicyRule,
	type PolicyPack,
} from "@hobo/contracts";
import { PersistenceUnavailableError, type PrincipalRef } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	AUTHZ_DECIDED_EVENT,
	AUTHZ_FAILURES,
	AUTHZ_METRICS,
	AUTHZ_STREAMS,
	CD_ACTION_SPECS,
	CD_ACTIONS,
	CD_BASELINE_PACK_ID,
	cdBaselineRules,
	createCdAuthorizer,
	parseAuthzDecision,
} from "../../src/authz/index.js";
import type {
	CdAction,
	OtelMetricPoint,
	TelemetrySink,
} from "../../src/ports.js";
import {
	AGENT,
	APPROVER,
	clock,
	context,
	MemoryEventStore,
	OPERATOR,
	T0,
	TENANT,
} from "./memory-store.js";

function denyPromoteFor(principalId: string): PolicyPack {
	return {
		id: "station.acme/delivery",
		version: "3.1.0",
		rules: [
			definePolicyRule({
				id: "station.acme/no-prod-promote",
				when: (r) => r.action === "cd.promote" && r.subject.id === principalId,
				decide: () => ({
					effect: "deny",
					reason: "interns may not promote to prod",
				}),
			}),
		],
	};
}

function setup(
	options: {
		pack?: PolicyPack;
		agentGrants?: Readonly<Record<string, readonly (CdAction | "*")[]>>;
		separateEnrollmentApprovers?: boolean;
		telemetry?: TelemetrySink;
	} = {},
) {
	const c = clock();
	const store = new MemoryEventStore(c.now);
	const authz = createCdAuthorizer({
		store,
		tenant: TENANT,
		now: c.now,
		policyPack: options.pack ?? createPermissiveDefaultPack(),
		...(options.agentGrants ? { agentGrants: options.agentGrants } : {}),
		...(options.separateEnrollmentApprovers === undefined
			? {}
			: { separateEnrollmentApprovers: options.separateEnrollmentApprovers }),
		...(options.telemetry ? { telemetry: options.telemetry } : {}),
	});
	return { c, store, authz };
}

function decisionsIn(store: MemoryEventStore) {
	return store
		.events(AUTHZ_DECIDED_EVENT)
		.map((e) => parseAuthzDecision(e.data as never))
		.filter((d) => d !== undefined);
}

describe("createCdAuthorizer", () => {
	it("an unauthorized action is refused with a recorded decision", async () => {
		const intern: PrincipalRef = { kind: "user", id: "intern@acme" };
		const { c, store, authz } = setup({ pack: denyPromoteFor(intern.id) });
		const result = await authz.authorize(
			"promote",
			{ freightId: "sha256:f1", targets: ["prod-1"] },
			context(c.now, intern),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const reason = result.reasons[0];
		expect(reason?.code).toBe("cd-authz-denied");
		expect(reason?.remediation).toBe(
			AUTHZ_FAILURES["cd-authz-denied"].remediation,
		);
		expect(reason?.message).toContain("interns may not promote to prod");
		const recorded = decisionsIn(store);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({
			decisionId: reason?.subject,
			action: "promote",
			principal: "user:intern@acme",
			effect: "deny",
			resource: { kind: "cd.freight", id: "sha256:f1" },
			decidedAt: new Date(T0).toISOString(),
			packId: "station.acme/delivery",
			packVersion: "3.1.0",
		});
		expect(recorded[0]?.policyIds).toContain("station.acme/no-prod-promote");
		expect(recorded[0]?.inputHash).toMatch(/^sha256:/u);
		const stream = store.stream(
			AUTHZ_STREAMS.resource("cd.freight", "sha256:f1"),
		);
		expect(stream).toHaveLength(1);
		expect(stream[0]?.actor).toEqual(intern);
	});

	it("records an allow decision before returning it", async () => {
		const { c, store, authz } = setup();
		const result = await authz.authorize(
			"source.define",
			{ name: "web-images" },
			context(c.now),
		);
		expect(result).toEqual({
			ok: true,
			value: {
				decisionId: expect.stringMatching(/^authz_[0-9a-f]{32}$/u),
				proposalOnly: false,
			},
		});
		const [decision] = decisionsIn(store);
		expect(decision?.effect).toBe("allow");
		expect(result.ok && result.value.decisionId).toBe(decision?.decisionId);
		expect(
			await authz.decisions({ kind: "cd.source", id: "web-images" }),
		).toHaveLength(1);
	});

	it("agent principal applying directly gets proposal only (§10, ADR-0094)", async () => {
		const { c, store, authz } = setup();
		const result = await authz.authorize(
			"promote",
			{ freightId: "sha256:f1" },
			context(c.now, AGENT),
		);
		expect(result).toMatchObject({ ok: true, value: { proposalOnly: true } });
		const [decision] = decisionsIn(store);
		expect(decision).toMatchObject({
			effect: "require-approval",
			proposalOnly: true,
			principal: "agent:agent-7",
		});
	});

	it("an agent delegating through a service is still proposal-only", async () => {
		const { c, authz } = setup();
		const svc: PrincipalRef = {
			kind: "service",
			id: "bot",
			delegatedBy: AGENT,
		};
		const result = await authz.authorize(
			"rollback",
			{ campId: "prod-1" },
			context(c.now, svc),
		);
		expect(result).toMatchObject({ ok: true, value: { proposalOnly: true } });
	});

	it("a granted agent may act outright, only for its granted actions", async () => {
		const { c, authz } = setup({
			agentGrants: { "agent-7": ["drift.remediate"] },
		});
		const ctx = context(c.now, AGENT);
		expect(
			await authz.authorize("drift.remediate", { campId: "c-1" }, ctx),
		).toMatchObject({ ok: true, value: { proposalOnly: false } });
		expect(
			await authz.authorize("promote", { freightId: "sha256:f1" }, ctx),
		).toMatchObject({ ok: true, value: { proposalOnly: true } });
		const all = setup({ agentGrants: { "agent-7": ["*"] } });
		expect(
			await all.authz.authorize(
				"promote",
				{ freightId: "sha256:f1" },
				context(all.c.now, AGENT),
			),
		).toMatchObject({ ok: true, value: { proposalOnly: false } });
	});

	it("an agent may propose a failover without a grant", async () => {
		const { c, authz } = setup();
		expect(
			await authz.authorize(
				"failover.propose",
				{ sourceCampId: "eu-1" },
				context(c.now, AGENT),
			),
		).toMatchObject({ ok: true, value: { proposalOnly: false } });
		expect(
			await authz.authorize(
				"failover.approve",
				{ failoverId: "fo-1" },
				context(c.now, AGENT),
			),
		).toMatchObject({ ok: true, value: { proposalOnly: true } });
	});

	it("the caller's pack composes most-restrictive-wins with the baseline", async () => {
		const pack: PolicyPack = {
			id: "station.acme/delivery",
			version: "1.0.0",
			rules: [
				definePolicyRule({
					id: "station.acme/override-needs-approval",
					when: (r) => r.action === "cd.window.override",
					decide: () => ({
						effect: "require-approval",
						reason: "two-person rule",
					}),
				}),
				definePolicyRule({
					id: "station.acme/allow-agent-promote",
					when: (r) => r.action === "cd.promote",
					decide: () => ({ effect: "allow", reason: "allowed" }),
				}),
			],
		};
		const { c, authz } = setup({ pack });
		expect(
			await authz.authorize(
				"window.override",
				{ window: "freeze" },
				context(c.now),
			),
		).toMatchObject({ ok: true, value: { proposalOnly: true } });
		// A pack `allow` never lifts the baseline agent rule (ADR-0094).
		expect(
			await authz.authorize(
				"promote",
				{ freightId: "sha256:f1" },
				context(c.now, AGENT),
			),
		).toMatchObject({ ok: true, value: { proposalOnly: true } });
	});

	it("a throwing policy rule denies with a recorded decision (fail closed)", async () => {
		const pack: PolicyPack = {
			id: "broken",
			version: "0.0.1",
			rules: [
				definePolicyRule({
					id: "broken/throws",
					when: () => true,
					decide: () => {
						throw new Error("boom");
					},
				}),
			],
		};
		const { c, store, authz } = setup({ pack });
		const result = await authz.authorize(
			"rollback",
			{ campId: "c-1" },
			context(c.now),
		);
		expect(result).toMatchObject({
			ok: false,
			reasons: [{ code: "cd-authz-policy-error" }],
		});
		expect(decisionsIn(store)[0]?.effect).toBe("deny");
	});

	it("refuses when the decision cannot be recorded (I10 fail closed)", async () => {
		const { c, store, authz } = setup();
		store.failNextAppend = new PersistenceUnavailableError("disk gone");
		const result = await authz.authorize(
			"rollback",
			{ campId: "c-1" },
			context(c.now),
		);
		expect(result).toMatchObject({
			ok: false,
			reasons: [{ code: "cd-authz-unrecorded" }],
		});
		expect(decisionsIn(store)).toHaveLength(0);
	});

	it("retries a decision append after a sequence conflict", async () => {
		const { c, store, authz } = setup();
		store.conflictsBeforeAppend = 2;
		const result = await authz.authorize(
			"rollback",
			{ campId: "c-1" },
			context(c.now),
		);
		expect(result.ok).toBe(true);
		expect(decisionsIn(store)).toHaveLength(1);
	});

	it("is idempotent: the same request at the same instant is one decision (I12)", async () => {
		const { c, store, authz } = setup();
		const a = await authz.authorize(
			"camp.taint",
			{ campId: "c-1" },
			context(c.now),
		);
		const b = await authz.authorize(
			"camp.taint",
			{ campId: "c-1" },
			context(c.now),
		);
		expect(a).toEqual(b);
		expect(decisionsIn(store)).toHaveLength(1);
		c.set(T0 + 1);
		await authz.authorize("camp.taint", { campId: "c-1" }, context(c.now));
		expect(decisionsIn(store)).toHaveLength(2);
	});

	it("records a secret-free subject (I9)", async () => {
		const { c, store, authz } = setup();
		await authz.authorize(
			"reconciler.enroll",
			{
				campSet: "edge",
				bootstrapToken: "hobo_bt_xyz",
				nested: { apiSecret: "s" },
			},
			context(c.now),
		);
		const [decision] = decisionsIn(store);
		expect(decision?.subject).toEqual({ campSet: "edge", nested: {} });
		expect(decision?.redacted).toEqual(["bootstrapToken", "nested.apiSecret"]);
		expect(JSON.stringify(store.all.map((p) => p.event))).not.toContain(
			"hobo_bt_xyz",
		);
	});

	it("refuses an action outside the CdAction vocabulary", async () => {
		const { c, store, authz } = setup();
		const result = await authz.authorize(
			"deploy.everything" as CdAction,
			{},
			context(c.now),
		);
		expect(result).toMatchObject({
			ok: false,
			reasons: [{ code: "cd-authz-unknown-action" }],
		});
		expect(store.all).toHaveLength(0);
	});

	it("refuses a request for another tenant", async () => {
		const { c, authz } = setup();
		const result = await authz.authorize(
			"promote",
			{ freightId: "sha256:f1" },
			{ ...context(c.now), tenant: "other" },
		);
		expect(result).toMatchObject({
			ok: false,
			reasons: [{ code: "cd-authz-tenant-mismatch" }],
		});
	});

	it("emits decision and refusal metrics through the TelemetrySink", async () => {
		const points: OtelMetricPoint[] = [];
		const telemetry: TelemetrySink = {
			spans: async () => undefined,
			metrics: async (p) => {
				points.push(...p);
			},
		};
		const intern: PrincipalRef = { kind: "user", id: "intern@acme" };
		const { c, authz } = setup({ pack: denyPromoteFor(intern.id), telemetry });
		await authz.authorize(
			"promote",
			{ freightId: "sha256:f1" },
			context(c.now, intern),
		);
		expect(points).toEqual([
			expect.objectContaining({
				name: AUTHZ_METRICS.decisions,
				attributes: {
					action: "promote",
					effect: "deny",
					"principal.kind": "user",
				},
			}),
			expect.objectContaining({
				name: AUTHZ_METRICS.refusals,
				attributes: { action: "promote", reason: "cd-authz-denied" },
			}),
		]);
	});

	it("a failing TelemetrySink never fails a decision", async () => {
		const telemetry: TelemetrySink = {
			spans: async () => undefined,
			metrics: async () => {
				throw new Error("collector down");
			},
		};
		const { c, authz } = setup({ telemetry });
		expect(
			(await authz.authorize("rollback", { campId: "c" }, context(c.now))).ok,
		).toBe(true);
	});
});

describe("one rule per CdAction", () => {
	it("the baseline pack has exactly one rule for every CdAction", () => {
		const rules = cdBaselineRules();
		expect(rules.map((r) => r.id)).toEqual(
			CD_ACTIONS.map((a) => `${CD_BASELINE_PACK_ID}/${a}`),
		);
		expect(new Set(CD_ACTIONS).size).toBe(31);
		for (const action of CD_ACTIONS) {
			expect(CD_ACTION_SPECS[action].action).toBe(action);
			const matching = rules.filter((r) =>
				r.when({
					subject: { kind: "user", id: "u" },
					action: `cd.${action}`,
					resource: { kind: "k", id: "i" },
					phase: "apply",
				}),
			);
			expect(matching).toHaveLength(1);
		}
	});

	it("every CdAction is decided, recorded and proposal-only for an ungranted agent", async () => {
		for (const action of CD_ACTIONS) {
			const { c, store, authz } = setup();
			const result = await authz.authorize(
				action,
				{ id: action },
				context(c.now, AGENT),
			);
			expect(result.ok).toBe(true);
			const [decision] = decisionsIn(store);
			expect(decision?.action).toBe(action);
			expect(decision?.policyIds).toContain(`${CD_BASELINE_PACK_ID}/${action}`);
			expect(result.ok && result.value.proposalOnly).toBe(
				action !== "failover.propose",
			);
		}
	});
});

describe("separation of duties for the two enrollment grants (R14, I24)", () => {
	const reconciler = { reconcilerId: "rec-1", keyThumbprint: "tp" };

	it("denies the second grant to the principal that made the first", async () => {
		const { c, store, authz } = setup();
		const ctx = context(c.now, OPERATOR);
		expect(
			(await authz.authorize("reconciler.approve-key", reconciler, ctx)).ok,
		).toBe(true);
		c.set(T0 + 1_000);
		const second = await authz.authorize("reconciler.accept", reconciler, ctx);
		expect(second).toMatchObject({
			ok: false,
			reasons: [{ code: "separation-of-duties" }],
		});
		expect(decisionsIn(store).map((d) => d.effect)).toEqual(["allow", "deny"]);
	});

	it("allows the second grant from a different principal, in either order", async () => {
		const { c, authz } = setup();
		expect(
			(
				await authz.authorize(
					"reconciler.accept",
					reconciler,
					context(c.now, APPROVER),
				)
			).ok,
		).toBe(true);
		c.set(T0 + 1_000);
		expect(
			(
				await authz.authorize(
					"reconciler.approve-key",
					reconciler,
					context(c.now, OPERATOR),
				)
			).ok,
		).toBe(true);
	});

	it("a denied or proposal-only first grant does not block the same principal", async () => {
		const { c, authz } = setup();
		// The agent's approve-key is only a proposal: it holds no grant.
		await authz.authorize(
			"reconciler.approve-key",
			reconciler,
			context(c.now, AGENT),
		);
		c.set(T0 + 1);
		expect(
			await authz.authorize(
				"reconciler.accept",
				reconciler,
				context(c.now, AGENT),
			),
		).toMatchObject({ ok: true, value: { proposalOnly: true } });
	});

	it("scopes the check to one reconciler", async () => {
		const { c, authz } = setup();
		const ctx = context(c.now, OPERATOR);
		await authz.authorize("reconciler.approve-key", reconciler, ctx);
		expect(
			(
				await authz.authorize(
					"reconciler.accept",
					{ reconcilerId: "rec-2" },
					ctx,
				)
			).ok,
		).toBe(true);
	});

	it("can be switched off explicitly (CD_DEFAULTS keeps it on)", async () => {
		const { c, authz } = setup({ separateEnrollmentApprovers: false });
		const ctx = context(c.now, OPERATOR);
		await authz.authorize("reconciler.approve-key", reconciler, ctx);
		c.set(T0 + 1);
		expect(
			(await authz.authorize("reconciler.accept", reconciler, ctx)).ok,
		).toBe(true);
	});
});
