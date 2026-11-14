// The reconciler device keys and enrollment request (L19): what
// `hobo deploy agent enroll --token-file` builds on the agent's host, the
// same way `hobo fleet enroll --token-file` does (local key generation, then
// `enroll`). The private keys never leave the host; the request carries only
// public keys and the signed key bundle.
import { describe, expect, it } from "vitest";
import { EnrollmentState, ReconcilerMode } from "../../src/_generated/cd_pb.js";
import {
	agentKeyFromJwk,
	createAgentEnrollment,
	generateReconcilerKeys,
	reconcilerEnrollment,
} from "../../src/agent/index.js";
import { CD_DEFAULTS } from "../../src/events.js";
import {
	asCamp,
	createClock,
	createFakeAuthorizer,
	createFakeInventory,
	createFakeRails,
	createFakeStore,
	createRecordingTelemetry,
	ctxAt,
	railWith,
	TENANT,
} from "../feed/fakes.js";
import {
	FLEET_ORIGIN,
	FLEET_TENANT,
	fleetFixture,
	YARD_FLEET,
} from "./fleet-fixture.js";

describe("reconciler device keys", () => {
	it("generates identity (P-256), SIGN (Ed25519) and SEAL (X25519) private JWKs", () => {
		const keys = generateReconcilerKeys();
		expect(keys.identity).toMatchObject({ kty: "EC", crv: "P-256" });
		expect(keys.sign).toMatchObject({ kty: "OKP", crv: "Ed25519" });
		expect(keys.seal).toMatchObject({ kty: "OKP", crv: "X25519" });
		for (const jwk of [keys.identity, keys.sign, keys.seal])
			expect(jwk.d).toEqual(expect.any(String));
		expect(agentKeyFromJwk(keys.sign).publicJwk.crv).toBe("Ed25519");
	});

	it("builds a RECONCILER EnrollmentRequest without private members, and the fleet enrolls it", async () => {
		const clock = createClock();
		const fixture = await fleetFixture(clock.now);
		const enrollment = createAgentEnrollment({
			store: createFakeStore(clock),
			tenant: TENANT,
			now: clock.now,
			authorizer: createFakeAuthorizer([]),
			rails: createFakeRails(railWith()),
			inventory: createFakeInventory({ edge: ["edge-1"] }),
			telemetry: createRecordingTelemetry(),
			fleet: fixture.fleet,
			publicOrigin: "https://station.test",
		});
		const alice = { kind: "user" as const, id: "alice" };
		const issued = await enrollment.issueToken(
			{
				campSet: "edge",
				campIds: [asCamp("edge-1")],
				mode: ReconcilerMode.AGENT,
				ttlMs: CD_DEFAULTS.bootstrapTokenTtlMs,
			},
			ctxAt(clock, alice),
		);
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		const keys = generateReconcilerKeys();
		const built = await reconcilerEnrollment({
			keys,
			token: issued.value.token,
			tenant: FLEET_TENANT,
			fleet: YARD_FLEET,
			origin: FLEET_ORIGIN,
			nowMs: clock.now(),
			agentVersion: "1.0.0",
		});
		expect(built.request.fleet).toBe(YARD_FLEET);
		expect(built.request.identityJwk).not.toContain('"d"');
		expect(built.request.proof).toEqual({
			case: "bootstrapToken",
			value: issued.value.token,
		});
		expect(built.dpopProof.split(".")).toHaveLength(3);
		const enrolled = await enrollment.enroll(
			{ request: built.request, dpopProof: built.dpopProof, campIds: [] },
			ctxAt(clock, { kind: "agent", id: "bootstrap" }),
		);
		expect(enrolled.ok).toBe(true);
		if (!enrolled.ok) return;
		expect(enrolled.value.reconciler.reconcilerId).toBe(built.memberId);
		expect(enrolled.value.state).toBe(EnrollmentState.PENDING);
	});
});
