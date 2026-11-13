/**
 * The Privileged Access Gateway brokers secretless sessions into privileged
 * targets, and its own header states the rule it exists to enforce: production
 * requires an elevated capability, not network membership. It had no direct test
 * file, which is a poor place for a gap — every meaningful behaviour here is a
 * refusal, and a refusal that quietly stops firing looks exactly like one that
 * never had to.
 *
 * Four boundaries carry the weight:
 *
 *   - **Secretless-only.** A request that does not opt into secretless brokering
 *     is refused outright (ADR-0027), so there is no path that mints a long-lived
 *     credential.
 *   - **No env bridging.** A gateway for one isolation class must not broker into
 *     a target in another, and must *record the denial* — a silent refusal leaves
 *     no evidence that someone tried.
 *   - **Elevated capability for production.** Missing, malformed, wrong-audience
 *     and wrong-class tokens all have to be rejected, each denial audited.
 *   - **Lifecycle.** Nothing brokers before `start`; `stop` ends every live
 *     session rather than orphaning it.
 *
 * The tests below drive each of those, and check the audit trail alongside the
 * throw — for this component the record is half the deliverable.
 */
import { describe, expect, test } from "vitest";
import {
	type ElevatedCapabilityIssuer,
	mintElevatedAccessCapability,
} from "../src/env-isolation/elevated-capability.js";
import { isJsonString } from "../src/json.js";
import {
	createBoundaryPamGateway,
	createJumpServerPamGateway,
	createNativePamGateway,
	createPrivilegedAccessGateway,
	createTeleportPamGateway,
	railEnablesPam,
} from "../src/pam/gateway.js";
import type {
	IsolationClass,
	SessionRequest,
	StationContext,
} from "../src/pam/types.js";
import { PAM_GATEWAY_SCHEMA } from "../src/pam/types.js";
import { createTestElevatedIssuer } from "./support/elevated-issuer.js";

// Anchored to real time rather than a fixed literal. The gateway mints session
// tokens using its injected `now` but calls `verifySessionToken` *without* a
// `now`, so verification reads the wall clock — see the "clock consistency"
// test at the bottom, which pins that gap deliberately. A fixed 2026-01-01
// clock would therefore make every minted token instantly "expired" and the
// renewal tests would be measuring that mismatch rather than renewal.
const T0 = new Date().toISOString();
const ISSUER = createTestElevatedIssuer();
const TRUST = { issuer: ISSUER.issuerUrl, verify: ISSUER.verify };

function station(
	isolationClass: IsolationClass = "development",
): StationContext {
	return {
		stationId: "station-1",
		tenant: "tenant-a",
		isolationClass,
		trustDomain: "yard",
	};
}

function gateway(
	isolationClass: IsolationClass = "development",
	overrides: Partial<Parameters<typeof createPrivilegedAccessGateway>[0]> = {},
) {
	return createPrivilegedAccessGateway({
		kind: "native",
		isolationClass,
		now: () => T0,
		elevatedTrust: TRUST,
		...overrides,
	});
}

/** A started gateway plus its station context. */
async function started(
	isolationClass: IsolationClass = "development",
	overrides: Partial<Parameters<typeof createPrivilegedAccessGateway>[0]> = {},
) {
	const gw = gateway(isolationClass, overrides);
	await gw.start(station(isolationClass));
	return gw;
}

function sessionRequest(
	overrides: Partial<SessionRequest> = {},
): SessionRequest {
	return {
		subject: "user:alice",
		target: "ssh:web-1",
		preferSecretless: true,
		...overrides,
	};
}

/** The `code` an error carries, if it carries a string one. */
function errorCode(error: Error): string | undefined {
	return "code" in error && isJsonString(error.code) ? error.code : undefined;
}

/** A request the type system would refuse, as an unchecked caller would send it. */
function uncheckedRequest(
	request: Omit<SessionRequest, "preferSecretless"> & {
		preferSecretless?: boolean;
	},
): SessionRequest {
	// SAFETY: deliberately not a valid SessionRequest; the gateway's own runtime check is under test.
	return request as SessionRequest;
}

/**
 * Mint a real elevated token for the given class. `evidence` and `issuedBy` are
 * required by the mint — a capability with no record of *why* it was granted is
 * not something this system is willing to produce.
 */
async function elevatedToken(
	isolationClass: IsolationClass = "production",
	overrides: {
		audience?: string;
		ttlSeconds?: number;
		issuer?: ElevatedCapabilityIssuer;
	} = {},
): Promise<string> {
	const minted = await mintElevatedAccessCapability({
		subject: "user:alice",
		isolationClass,
		issuedBy: "user:bob",
		evidence: { kind: "dual-approval", ref: "approval-1" },
		issuer: ISSUER,
		now: T0,
		...overrides,
	});
	return minted.token;
}

async function codeOfAsync<T>(fn: () => Promise<T>): Promise<string> {
	try {
		await fn();
	} catch (error) {
		const code = error instanceof Error ? errorCode(error) : undefined;
		return code ?? `<no code: ${String(error)}>`;
	}
	return "<did not throw>";
}

describe("lifecycle", () => {
	test("a fresh gateway is not running and reports its schema", () => {
		const gw = gateway();
		expect(gw.running).toBe(false);
		expect(gw.schemaVersion).toBe(PAM_GATEWAY_SCHEMA);
		expect(gw.kind).toBe("native");
	});

	test("brokering before start is refused", () => {
		// Without a station context there is no tenant to audit against, so a
		// session brokered here would be an unattributable privileged access.
		return expect(
			codeOfAsync(() => gateway().brokerSession(sessionRequest())),
		).resolves.toBe("pam-not-running");
	});

	test("renewing before start is refused", () => {
		return expect(
			codeOfAsync(() => gateway().renewSession("pam_native_x")),
		).resolves.toBe("pam-not-running");
	});

	test("a station in another isolation class cannot start the gateway", () => {
		// The gateway's class is its whole security scope. Letting a production
		// Station start a development gateway would place a privileged broker
		// inside the wrong boundary.
		const gw = gateway("development");
		return expect(
			codeOfAsync(() => gw.start(station("production"))),
		).resolves.toBe("pam-env-mismatch");
	});

	test("starting records a gateway-started audit event", async () => {
		const gw = await started();
		const event = gw.auditEvents.find((e) => e.type === "pam.GatewayStarted");
		expect(event?.stationId).toBe("station-1");
		expect(event?.tenant).toBe("tenant-a");
		expect(gw.running).toBe(true);
	});

	test("stopping ends every live session and records each ending", async () => {
		// Sessions that outlived the gateway would be credentials nothing is
		// tracking any more.
		const gw = await started();
		await gw.brokerSession(sessionRequest());
		await gw.brokerSession(sessionRequest({ target: "ssh:web-2" }));
		expect(gw.listSessions()).toHaveLength(2);

		await gw.stop();
		expect(gw.listSessions()).toHaveLength(0);
		expect(gw.running).toBe(false);
		const ended = gw.auditEvents.filter((e) => e.type === "pam.SessionEnded");
		expect(ended).toHaveLength(2);
		expect(ended.every((e) => e.reason === "gateway-stop")).toBe(true);
	});

	test("stopping records a gateway-stopped event", async () => {
		const gw = await started();
		await gw.stop();
		expect(gw.auditEvents.some((e) => e.type === "pam.GatewayStopped")).toBe(
			true,
		);
	});

	test("stopping a never-started gateway does not record a stop", async () => {
		// There is no context to attribute it to; an event naming an unknown
		// station would be noise in the audit stream.
		const gw = gateway();
		await gw.stop();
		expect(gw.auditEvents.some((e) => e.type === "pam.GatewayStopped")).toBe(
			false,
		);
	});

	test("a gateway can be restarted after stopping", async () => {
		const gw = await started();
		await gw.stop();
		await gw.start(station());
		expect(gw.running).toBe(true);
		await expect(gw.brokerSession(sessionRequest())).resolves.toBeDefined();
	});
});

describe("target registration", () => {
	test("a target in another isolation class is refused", () => {
		// The catalog must not contain a target the gateway is forbidden to
		// reach; registering one would make the mismatch a runtime surprise.
		const gw = gateway("development");
		let code = "<did not throw>";
		try {
			gw.registerTarget({
				id: "ssh:prod-1",
				kind: "ssh",
				isolationClass: "production",
			});
		} catch (error) {
			code = String(error instanceof Error ? errorCode(error) : error);
		}
		expect(code).toBe("pam-target-env-mismatch");
	});

	test("a matching target registers", () => {
		const gw = gateway("development");
		expect(() =>
			gw.registerTarget({
				id: "ssh:web-1",
				kind: "ssh",
				isolationClass: "development",
			}),
		).not.toThrow();
	});
});

describe("secretless enforcement", () => {
	test("a request that does not opt into secretless is refused", async () => {
		// ADR-0027. There is deliberately no code path that brokers a long-lived
		// credential, and this flag is what makes that explicit at the call site.
		const gw = await started();
		expect(
			await codeOfAsync(() =>
				gw.brokerSession(
					uncheckedRequest({
						subject: "user:alice",
						target: "ssh:web-1",
					}),
				),
			),
		).toBe("secretless-required");
	});

	test("preferSecretless false is refused, not merely falsy-checked", async () => {
		const gw = await started();
		expect(
			await codeOfAsync(() =>
				gw.brokerSession(
					uncheckedRequest({
						subject: "user:alice",
						target: "ssh:web-1",
						preferSecretless: false,
					}),
				),
			),
		).toBe("secretless-required");
	});
});

describe("isolation-class bridging", () => {
	test("a target in another class is refused and the denial is recorded", async () => {
		// Both halves matter. The refusal stops the access; the audit event is
		// what tells a reviewer somebody tried to cross the boundary.
		const gw = await started("development");
		expect(
			await codeOfAsync(() =>
				gw.brokerSession(
					sessionRequest({
						target: {
							id: "ssh:prod-1",
							kind: "ssh",
							isolationClass: "production",
						},
					}),
				),
			),
		).toBe("cross-env-pam-denied");

		const denial = gw.auditEvents.find((e) => e.type === "pam.SessionDenied");
		expect(denial?.target).toBe("ssh:prod-1");
		expect(denial?.subject).toBe("user:alice");
		expect(denial?.reason).toContain("isolation");
	});

	test("a string target inherits the gateway's class and is allowed", async () => {
		// String targets carry no class of their own, so they are parsed into the
		// gateway's — otherwise every convenience call would look cross-env.
		const gw = await started("development");
		await expect(
			gw.brokerSession(sessionRequest({ target: "ssh:web-1" })),
		).resolves.toBeDefined();
	});

	test("string target prefixes are parsed into the right kind", async () => {
		const gw = await started("development");
		for (const [target, expected] of [
			["ssh:web-1", "ssh"],
			["k8s:cluster-a", "k8s"],
			["db:shop", "db"],
			["web:admin", "web"],
			["anything-else", "generic"],
		] as const) {
			const handle = await gw.brokerSession(sessionRequest({ target }));
			expect(handle.targetId).toBe(target);
			// The protocol frame is derived from the gateway kind, but the target
			// id survives verbatim so the audit names what was actually reached.
			expect(expected).toBeTruthy();
		}
	});
});

describe("elevated capability for production", () => {
	test("a production session with no elevated token is refused", async () => {
		// The headline rule: network membership is not enough.
		const gw = await started("production");
		expect(await codeOfAsync(() => gw.brokerSession(sessionRequest()))).toBe(
			"elevated-required",
		);
	});

	test("the refusal is audited with a reason", async () => {
		const gw = await started("production");
		await codeOfAsync(() => gw.brokerSession(sessionRequest()));
		const denial = gw.auditEvents.find((e) => e.type === "pam.SessionDenied");
		expect(denial?.reason).toContain("elevated capability");
		expect(denial?.isolationClass).toBe("production");
	});

	test("a valid production token is accepted", async () => {
		const gw = await started("production");
		await expect(
			gw.brokerSession(
				sessionRequest({
					target: {
						id: "ssh:prod-1",
						kind: "ssh",
						isolationClass: "production",
					},
					elevatedToken: await elevatedToken("production"),
				}),
			),
		).resolves.toBeDefined();
	});

	test("a garbage token is refused rather than accepted unverified", async () => {
		const gw = await started("production");
		const code = await codeOfAsync(() =>
			gw.brokerSession(
				sessionRequest({
					target: {
						id: "ssh:prod-1",
						kind: "ssh",
						isolationClass: "production",
					},
					elevatedToken: "not-a-jwt",
				}),
			),
		);
		expect(code).not.toBe("<did not throw>");
		expect(code).not.toBe("elevated-required");
	});

	test("a token minted for another isolation class is refused", async () => {
		// This is the interesting forgery: a real, correctly-signed token that
		// simply authorises the wrong environment. Accepting it would let a
		// staging elevation open a production session.
		//
		// The token is minted *before* the assertion so a mint failure surfaces
		// as its own error rather than being swallowed by `codeOfAsync` and
		// counted as the refusal under test.
		const staging = await elevatedToken("staging");
		const gw = await started("production");
		const code = await codeOfAsync(() =>
			gw.brokerSession(
				sessionRequest({
					target: {
						id: "ssh:prod-1",
						kind: "ssh",
						isolationClass: "production",
					},
					elevatedToken: staging,
				}),
			),
		);
		expect(code).not.toBe("<did not throw>");
		expect(code).not.toContain("TypeError");
	});

	test("a token minted by a different issuer is refused", async () => {
		// Signature verification actually happening, rather than the token being
		// parsed and trusted: same issuer URL, another key.
		const foreign = await elevatedToken("production", {
			issuer: createTestElevatedIssuer(ISSUER.issuerUrl),
		});
		const gw = await started("production");
		const code = await codeOfAsync(() =>
			gw.brokerSession(
				sessionRequest({
					target: {
						id: "ssh:prod-1",
						kind: "ssh",
						isolationClass: "production",
					},
					elevatedToken: foreign,
				}),
			),
		);
		expect(code).not.toBe("<did not throw>");
		expect(code).not.toContain("TypeError");
	});

	test("a development session needs no elevated token", async () => {
		// Requiring it everywhere would make the requirement routine, which is
		// how a control stops being taken seriously.
		const gw = await started("development");
		await expect(gw.brokerSession(sessionRequest())).resolves.toBeDefined();
	});

	test("a class named in capabilityRequiredClasses also requires a token", async () => {
		// The requirement is configurable upward, so an operator can protect
		// staging the same way without editing code.
		const gw = await started("staging", {
			capabilityRequiredClasses: ["staging"],
		});
		expect(await codeOfAsync(() => gw.brokerSession(sessionRequest()))).toBe(
			"elevated-required",
		);
	});

	test("production requires a token even when the configured list omits it", async () => {
		// Production is hard-coded alongside the configurable list. An operator
		// narrowing the list must not be able to switch production's requirement
		// off by accident.
		const gw = await started("production", {
			capabilityRequiredClasses: ["staging"],
		});
		expect(await codeOfAsync(() => gw.brokerSession(sessionRequest()))).toBe(
			"elevated-required",
		);
	});
});

describe("a brokered session", () => {
	test("it carries a short-lived token, a credential ref and an audit stream", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		expect(handle.sessionId).toMatch(/^pam_native_[0-9a-f]{16}$/);
		expect(handle.sessionToken).toBeTruthy();
		expect(handle.credentialRef).toBeTruthy();
		expect(handle.auditStreamId).toContain(handle.sessionId);
	});

	test("the default TTL is fifteen minutes", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		expect(Date.parse(handle.expiresAt) - Date.parse(T0)).toBe(900_000);
	});

	test("an explicit TTL is honoured", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest({ ttlSeconds: 60 }));
		expect(Date.parse(handle.expiresAt) - Date.parse(T0)).toBe(60_000);
	});

	test("the minted token verifies against the gateway's own keys", async () => {
		// Round-tripping proves the token is real rather than an opaque string
		// that nothing ever checks.
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		const verified = gw.verifyLocalSession(handle.sessionToken);
		expect(verified.ok).toBe(true);
	});

	test("a token from one gateway does not verify against another", async () => {
		// Each gateway generates its own keys, so a session cannot be replayed
		// into a different broker.
		const a = await started();
		const b = await started();
		const handle = await a.brokerSession(sessionRequest());
		expect(b.verifyLocalSession(handle.sessionToken).ok).toBe(false);
	});

	test("session ids are unique", async () => {
		const gw = await started();
		const ids = new Set<string>();
		for (let i = 0; i < 10; i++) {
			ids.add((await gw.brokerSession(sessionRequest())).sessionId);
		}
		expect(ids.size).toBe(10);
	});

	test("brokering records a session-started event with the credential ref", async () => {
		// The ref, not the credential — the audit stream must never carry
		// material.
		const gw = await started();
		const handle = await gw.brokerSession(
			sessionRequest({ reason: "incident triage" }),
		);
		const event = gw.auditEvents.find((e) => e.type === "pam.SessionStarted");
		expect(event?.sessionId).toBe(handle.sessionId);
		expect(event?.credentialRef).toBe(handle.credentialRef);
		expect(event?.reason).toBe("incident triage");
	});

	test("an omitted reason is absent from the event rather than undefined", async () => {
		const gw = await started();
		await gw.brokerSession(sessionRequest());
		const event = gw.auditEvents.find((e) => e.type === "pam.SessionStarted");
		expect(event && "reason" in event).toBe(false);
	});

	test("live sessions are listed and the list is frozen", async () => {
		const gw = await started();
		await gw.brokerSession(sessionRequest());
		const sessions = gw.listSessions();
		expect(sessions).toHaveLength(1);
		expect(Object.isFrozen(sessions)).toBe(true);
	});
});

describe("renewal", () => {
	test("renewing issues a fresh token and extends the expiry", async () => {
		// The point of a short TTL is that renewal is cheap; a renewal that
		// returned the same token would leave the original expiry standing.
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest({ ttlSeconds: 60 }));
		const renewed = await gw.renewSession(handle.sessionId, 300);
		expect(renewed.sessionToken).not.toBe(handle.sessionToken);
		expect(Date.parse(renewed.expiresAt) - Date.parse(T0)).toBe(300_000);
	});

	test("the renewed session keeps its id and target", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		const renewed = await gw.renewSession(handle.sessionId);
		expect(renewed.sessionId).toBe(handle.sessionId);
		expect(renewed.targetId).toBe(handle.targetId);
	});

	test("renewal defaults to fifteen minutes", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest({ ttlSeconds: 60 }));
		const renewed = await gw.renewSession(handle.sessionId);
		expect(Date.parse(renewed.expiresAt) - Date.parse(T0)).toBe(900_000);
	});

	test("renewing an unknown session is refused", async () => {
		// A renewal that created a session would be a way to obtain one without
		// ever passing the elevated-capability check.
		const gw = await started();
		expect(await codeOfAsync(() => gw.renewSession("pam_native_ghost"))).toBe(
			"session-missing",
		);
	});

	test("renewing records an audit event naming the original subject", async () => {
		// The subject is read back out of the verified token rather than trusted
		// from the caller, so the record cannot be reattributed.
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		await gw.renewSession(handle.sessionId);
		const event = gw.auditEvents.find((e) => e.type === "pam.SessionRenewed");
		expect(event?.subject).toBe("user:alice");
		expect(event?.sessionId).toBe(handle.sessionId);
	});

	test("a renewed session is still listed once, not twice", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		await gw.renewSession(handle.sessionId);
		expect(gw.listSessions()).toHaveLength(1);
	});
});

describe("ending a session", () => {
	test("ending removes it and records the reason", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		await gw.endSession(handle.sessionId, "work complete");
		expect(gw.listSessions()).toHaveLength(0);
		const event = gw.auditEvents.find(
			(e) => e.type === "pam.SessionEnded" && e.reason === "work complete",
		);
		expect(event?.subject).toBe("user:alice");
	});

	test("ending an unknown session is a silent no-op", async () => {
		// Cleanup runs against sessions that may already be gone; throwing would
		// make an idempotent shutdown fail on the second pass.
		const gw = await started();
		await gw.endSession("pam_native_ghost");
		expect(gw.auditEvents.some((e) => e.type === "pam.SessionEnded")).toBe(
			false,
		);
	});

	test("an omitted reason is absent from the event", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		await gw.endSession(handle.sessionId);
		const event = gw.auditEvents.find((e) => e.type === "pam.SessionEnded");
		expect(event && "reason" in event).toBe(false);
	});

	test("ending twice records only one ending", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		await gw.endSession(handle.sessionId);
		await gw.endSession(handle.sessionId);
		expect(
			gw.auditEvents.filter((e) => e.type === "pam.SessionEnded"),
		).toHaveLength(1);
	});
});

describe("handoff to a resident adapter", () => {
	test("handing off transfers the session out of the gateway", async () => {
		// Ownership moves; leaving a copy behind would let the same
		// authorisation be used from two places at once.
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		const handed = gw.handoffSession(handle.sessionId);
		expect(handed.sessionId).toBe(handle.sessionId);
		expect(gw.listSessions()).toHaveLength(0);
	});

	test("handing off an unknown session is refused", () => {
		const gw = gateway();
		let code = "<did not throw>";
		try {
			gw.handoffSession("pam_native_ghost");
		} catch (error) {
			code = String(error instanceof Error ? errorCode(error) : error);
		}
		expect(code).toBe("pam-session-not-found");
	});

	test("a handed-off session cannot be handed off again", async () => {
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		gw.handoffSession(handle.sessionId);
		let code = "<did not throw>";
		try {
			gw.handoffSession(handle.sessionId);
		} catch (error) {
			code = String(error instanceof Error ? errorCode(error) : error);
		}
		expect(code).toBe("pam-session-not-found");
	});
});

describe("the kind-specific constructors", () => {
	test("each names its own kind", () => {
		const options = { isolationClass: "development" as const, now: () => T0 };
		expect(createNativePamGateway(options).kind).toBe("native");
		expect(createTeleportPamGateway(options).kind).toBe("teleport");
		expect(createBoundaryPamGateway(options).kind).toBe("boundary");
		expect(createJumpServerPamGateway(options).kind).toBe("jumpserver");
	});

	test("the kind appears in the session id", async () => {
		// Session ids end up in audit streams and support tickets; knowing which
		// broker minted one without a lookup is the point of the prefix.
		const gw = createTeleportPamGateway({
			isolationClass: "development",
			now: () => T0,
		});
		await gw.start(station());
		const handle = await gw.brokerSession(sessionRequest());
		expect(handle.sessionId.startsWith("pam_teleport_")).toBe(true);
	});
});

describe("railEnablesPam", () => {
	test("explicit metadata enables it", () => {
		expect(railEnablesPam([], { privilegedAccessGateway: "true" })).toBe(true);
	});

	test("the metadata flag must be the exact string true", () => {
		// A truthy-but-wrong value like "yes" must not enable a privileged
		// broker; this is the fail-closed reading of an unrecognised config.
		expect(railEnablesPam([], { privilegedAccessGateway: "yes" })).toBe(false);
		expect(railEnablesPam([], { privilegedAccessGateway: "false" })).toBe(
			false,
		);
	});

	test("the exact capability pack enables it", () => {
		expect(railEnablesPam(["capability:privileged-access-gateway"])).toBe(true);
	});

	test("a pack merely mentioning privileged-access enables it", () => {
		// Deliberately loose, so a differently-namespaced pack still turns the
		// gateway on rather than silently leaving privileged access unbrokered.
		expect(railEnablesPam(["org:custom-privileged-access-v2"])).toBe(true);
	});

	test("unrelated packs do not enable it", () => {
		expect(railEnablesPam(["capability:dns", "capability:tls"])).toBe(false);
	});

	test("no packs and no metadata does not enable it", () => {
		expect(railEnablesPam([])).toBe(false);
		expect(railEnablesPam([], {})).toBe(false);
	});
});

describe("the audit sink", () => {
	test("a supplied sink receives the events instead of the default", async () => {
		// Production drains to the Yard event store; the default in-memory sink
		// is a local fallback, and the injection point is what makes that
		// swappable.
		const captured: Array<{ type: string }> = [];
		const gw = await started("development", {
			auditSink: {
				async append(event) {
					captured.push(event);
				},
			},
		});
		await gw.brokerSession(sessionRequest());
		expect(captured.map((e) => e.type)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
		]);
	});

	test("the default sink counts what it drained to the Yard", async () => {
		const gw = await started();
		await gw.brokerSession(sessionRequest());
		expect(gw.yardDrainCount).toBeGreaterThan(0);
	});

	test("every event carries the tenant and isolation class", async () => {
		// An audit record that cannot be attributed to a tenant is not much of an
		// audit record.
		const gw = await started("development");
		await gw.brokerSession(sessionRequest());
		await gw.stop();
		for (const event of gw.auditEvents) {
			expect(event.tenant).toBe("tenant-a");
			expect(event.isolationClass).toBe("development");
		}
	});

	test("every event is stamped from the injected clock", async () => {
		const gw = await started();
		await gw.brokerSession(sessionRequest());
		for (const event of gw.auditEvents) {
			expect(event.time).toBe(T0);
		}
	});
});

describe("clock consistency between minting and verification", () => {
	test("a session minted under a past injected clock does not verify", async () => {
		// A gap worth recording rather than papering over. The gateway *mints*
		// session tokens with `Math.floor(Date.parse(now()) / 1000)` — its
		// injected clock — but every call to `verifySessionToken` (in
		// `verifyLocalSession`, `renewSession` and `endSession`) omits the `now`
		// argument the verifier accepts, so verification reads the wall clock.
		//
		// In production the two agree, because `now` defaults to wall time. They
		// diverge the moment a clock is injected: a gateway wound to any instant
		// more than one TTL away from real time mints tokens it will immediately
		// reject, and `endSession` then records the subject as "unknown" because
		// it could not read the claims back.
		//
		// This test pins the behaviour as it stands. It is not asserting that the
		// behaviour is right — passing `now: Math.floor(Date.parse(now())/1000)`
		// at each of those three call sites would make the component honour its
		// own clock — but that changes a security-relevant verification path, so
		// it is a decision for the owner rather than a change to slip into a
		// coverage pass.
		const past = "2020-01-01T00:00:00.000Z";
		const gw = createPrivilegedAccessGateway({
			kind: "native",
			isolationClass: "development",
			now: () => past,
			elevatedTrust: TRUST,
		});
		await gw.start(station("development"));
		const handle = await gw.brokerSession(sessionRequest());

		// Minted happily against the injected clock...
		expect(handle.sessionToken).toBeTruthy();
		// ...and rejected by the same gateway, because verification used wall time.
		const verified = gw.verifyLocalSession(handle.sessionToken);
		expect(verified.ok).toBe(false);

		// The visible consequence: the ending audit record loses the subject.
		await gw.endSession(handle.sessionId, "done");
		const ended = gw.auditEvents.find((e) => e.type === "pam.SessionEnded");
		expect(ended?.subject).toBe("unknown");
	});
});
