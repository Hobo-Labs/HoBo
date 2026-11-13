// Local mode has no bus, sign-in, recorder, projection, audit chain or
// credential issuer (§6.2, D6). The ports and parts it hands the enrollment
// state machine for those refuse, and the in-process registry keeps the
// newest record it is given.
import { create, toBinary } from "@bufbuild/protobuf";
import { parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	ApprovalDecisionSchema,
	AuditEntrySchema,
	CoordinationMode,
	FleetRecordSchema,
	MemberRecordSchema,
	MemberState,
	MembershipSchema,
	SignedEnvelopeSchema,
	SignInCallbackSchema,
	SignInCompleteSchema,
	SignInDeviceCodeSchema,
	SignInPollSchema,
	SignInStartSchema,
} from "../../src/_generated/fleet_pb.js";
import { parseFleetId, parseMemberId, parseWorkDigest } from "../../src/ids.js";
import { createLocalBus } from "../../src/local/bus.js";
import {
	localParts,
	ownerOnlyPolicy,
	refusingDeps,
} from "../../src/local/parts.js";
import { createLocalRegistry } from "../../src/local/registry.js";
import type { FleetCommands } from "../../src/ports.js";

const TENANT = parseTenantId("relay");
const FLEET = parseFleetId("cache");
const MEMBER = parseMemberId(`bkd_${"0".repeat(32)}`);
const ENVELOPE = create(SignedEnvelopeSchema, {});
const DIGEST = parseWorkDigest("0".repeat(32));

function memberEnvelope(sequence: number, state: MemberState) {
	return create(SignedEnvelopeSchema, {
		payload: toBinary(
			MemberRecordSchema,
			create(MemberRecordSchema, {
				memberId: MEMBER,
				tenant: TENANT,
				state,
				recordSequence: sequence,
				issuedAt: "2026-11-01T10:00:00.000Z",
				notAfter: "2026-11-01T10:30:00.000Z",
				authorityIncarnation: 3,
				memberships: [create(MembershipSchema, { fleet: FLEET, name: "a" })],
			}),
		),
	});
}

function fleetEnvelope(revision: number, coordination: CoordinationMode) {
	return create(SignedEnvelopeSchema, {
		payload: toBinary(
			FleetRecordSchema,
			create(FleetRecordSchema, {
				fleetId: FLEET,
				tenant: TENANT,
				coordination,
				revision,
				issuedAt: "2026-11-01T10:00:00.000Z",
				notAfter: "2026-11-01T10:30:00.000Z",
			}),
		),
	});
}

describe("the in-process registry", () => {
	it("keeps the newest record without its signing-time fields", async () => {
		const registry = createLocalRegistry(TENANT);
		await registry.publisher.putMember(
			memberEnvelope(2, MemberState.ACTIVE),
			MEMBER,
		);
		await registry.publisher.putMember(
			memberEnvelope(1, MemberState.PENDING),
			MEMBER,
		);
		const member = await registry.view.member(MEMBER);
		expect(member?.state).toBe(MemberState.ACTIVE);
		expect(member?.recordSequence).toBe(2);
		expect(member?.issuedAt).toBe("");
		expect(member?.notAfter).toBe("");
		expect(member?.authorityIncarnation).toBe(0);

		await registry.publisher.putFleet(
			fleetEnvelope(2, CoordinationMode.ONE_ACTIVE),
			FLEET,
		);
		await registry.publisher.putFleet(
			fleetEnvelope(1, CoordinationMode.MANY_ACTIVE),
			FLEET,
		);
		const fleet = await registry.view.fleet(FLEET);
		expect(fleet?.revision).toBe(2);
		expect(fleet?.coordination).toBe(CoordinationMode.ONE_ACTIVE);
		expect(fleet?.notAfter).toBe("");

		await registry.publisher.putView(ENVELOPE, FLEET);
		expect(await registry.view.view(FLEET)).toBeUndefined();
	});
});

describe("the absent bus", () => {
	it("rejects every publish and read, and delivers nothing to a subscriber", async () => {
		const bus = createLocalBus(createLocalRegistry(TENANT));
		const absent = [
			bus.observations.publish(ENVELOPE, MEMBER, MEMBER),
			bus.observations.read(1),
			bus.claims.claim(ENVELOPE, FLEET, DIGEST),
			bus.claims.holder(FLEET, DIGEST),
			bus.claims.remove(FLEET, DIGEST),
			bus.offers.publish(ENVELOPE, FLEET),
			bus.submissions.publish(ENVELOPE, FLEET),
			bus.orders.deliver(ENVELOPE, MEMBER),
			bus.events.publish(ENVELOPE, MEMBER, "receipt"),
			bus.control.send(ENVELOPE, MEMBER),
			bus.relay.send(MEMBER, "s", new Uint8Array()),
			bus.audit.append(create(AuditEntrySchema, {})),
			bus.audit.appendCheckpoint(ENVELOPE),
			bus.audit.entries(0, 1),
			bus.audit.proposeTrust(ENVELOPE),
			bus.replay.firstUse("scope", "id", 0),
		];
		for (const call of absent)
			await expect(call).rejects.toThrow(/local mode has no bus/u);

		const handler = async () => {};
		const subscriptions = [
			bus.claims.subscribe([FLEET], "start", handler),
			bus.offers.subscribe([FLEET], "start", handler),
			bus.submissions.subscribe([FLEET], "start", handler),
			bus.orders.subscribe(MEMBER, "start", handler),
			bus.orders.observeAll("start", handler),
			bus.events.subscribe(["receipt"], "start", handler),
			bus.control.subscribe(MEMBER, "start", handler),
			bus.relay.subscribe(MEMBER, handler),
			bus.audit.onWitnessed(handler),
			bus.audit.onTrustProposed(handler),
			bus.audit.onTrustWitnessed(handler),
		];
		for (const subscription of subscriptions)
			await expect(subscription.stop()).resolves.toBeUndefined();
		expect(bus.status()).toBe("closed");
		await expect(bus.close()).resolves.toBeUndefined();
	});
});

const refused = async () =>
	({ ok: false, error: { code: "unavailable", message: "x" } }) as const;

describe("the absent parts", () => {
	const fleets: FleetCommands = {
		listFleets: refused,
		getFleet: refused,
		defineFleet: refused,
		fleetView: refused,
		fleetVerdict: refused,
		grantSession: refused,
		submitWork: refused,
	};

	it("passes the fleet commands through and refuses sign-in, work status and logs", async () => {
		const parts = localParts(fleets);
		expect(parts.fleets).toBe(fleets);
		const signIn = parts.signIn;
		for (const call of [
			signIn.start(create(SignInStartSchema, {})),
			signIn.device(create(SignInDeviceCodeSchema, {})),
			signIn.callback(create(SignInCallbackSchema, {})),
			signIn.approval("state"),
			signIn.approve(create(ApprovalDecisionSchema, {})),
			signIn.complete(create(SignInCompleteSchema, {}), ""),
			signIn.poll(create(SignInPollSchema, {}), ""),
			parts.recorder.workStatus("id"),
			parts.recorder.workLogs("id"),
		])
			expect(await call).toMatchObject({
				ok: false,
				error: { code: "unavailable" },
			});
		parts.recorder.start();
		await parts.recorder.stop();
		expect(parts.recorder.reliability().size).toBe(0);
		await parts.projection.tick();
		await parts.projection.caughtUp();
		await parts.audit.tick();
	});

	it("issues no credentials and verifies no account, OIDC token or certificate chain", async () => {
		const deps = refusingDeps();
		const principal = { kind: "service", id: "hosted-relay" } as const;
		await expect(
			deps.issuer.issuePerson({
				principal,
				tenant: TENANT,
				tags: [],
				jkt: "",
				ttlMs: 1,
			}),
		).rejects.toThrow("local mode issues no credentials");
		await expect(
			deps.issuer.issueMember({
				member: create(MemberRecordSchema, {}),
				audiences: [],
				jkt: "",
				ttlMs: 1,
			}),
		).rejects.toThrow("local mode issues no credentials");
		expect(deps.issuer.verify("t", "a", 0).ok).toBe(false);
		expect(deps.issuer.jwks()).toBe('{"keys":[]}');
		expect(await deps.directory.tenantsOf(principal, {})).toEqual([]);
		expect((await deps.accounts.verify("b")).ok).toBe(false);
		expect((await deps.assertions.verifyOidc("a", "b")).ok).toBe(false);
		expect(
			deps.assertions.verifyCertificateChain({
				chainPem: [],
				identityJwk: "",
				rootsPem: [],
				nowMs: 0,
			}).ok,
		).toBe(false);
		expect(deps.signIn).toEqual([]);
		expect(deps.overlayMinters).toEqual([]);
	});

	it("allows the owner and refuses anyone else", async () => {
		const policy = ownerOnlyPolicy({ kind: "service", id: "hosted-relay" });
		const request = (identity: string) => ({
			subject: { identity, tenantId: TENANT, tags: [] },
			action: "fleet.member.declare",
			resource: { kind: "fleet", id: FLEET, tenantId: TENANT },
		});
		expect(
			(await policy.evaluate(request("service:hosted-relay"))).effect,
		).toBe("allow");
		expect((await policy.evaluate(request("user:mallory"))).effect).toBe(
			"deny",
		);
	});
});
