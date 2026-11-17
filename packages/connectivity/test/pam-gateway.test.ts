import { describe, expect, test } from "vitest";

import { mintElevatedAccessCapability } from "../src/env-isolation/elevated-capability.js";
import type { IsolationClass } from "../src/env-isolation/types.js";
import { isJsonString } from "../src/json.js";
import {
	createBoundaryPamGateway,
	createJumpServerPamGateway,
	createNativePamGateway,
	createPrivilegedAccessGateway,
	createTeleportPamGateway,
	railEnablesPam,
} from "../src/pam/gateway.js";
import type { SessionRequest, StationContext } from "../src/pam/types.js";
import { PAM_GATEWAY_SCHEMA } from "../src/pam/types.js";

const T0 = new Date().toISOString();
const HMAC = "test-elevated-secret-not-for-production";

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
		elevatedHmacSecret: HMAC,
		...overrides,
	});
}

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
	} as SessionRequest;
}

function elevatedToken(
	isolationClass: IsolationClass = "production",
	overrides: {
		audience?: string;
		ttlSeconds?: number;
		hmacSecret?: string;
	} = {},
) {
	return mintElevatedAccessCapability({
		subject: "user:alice",
		isolationClass,
		issuedBy: "user:bob",
		evidence: { kind: "dual-approval", ref: "approval-1" },
		hmacSecret: HMAC,
		allowDefaultSecret: false,
		now: T0,
		...overrides,
	}).token;
}

async function codeOfAsync<T>(fn: () => Promise<T>): Promise<string> {
	try {
		await fn();
	} catch (error) {
		return error instanceof Error && "code" in error && isJsonString(error.code)
			? error.code
			: `<no code: ${String(error)}>`;
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
		const gw = gateway("development");
		let code = "<did not throw>";
		try {
			gw.registerTarget({
				id: "ssh:prod-1",
				kind: "ssh",
				isolationClass: "production",
			});
		} catch (error) {
			code = String((error as { code?: unknown }).code);
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
		const gw = await started();
		const request = sessionRequest();
		Reflect.deleteProperty(request, "preferSecretless");
		expect(await codeOfAsync(() => gw.brokerSession(request))).toBe(
			"secretless-required",
		);
	});

	test("preferSecretless false is refused, not merely falsy-checked", async () => {
		const gw = await started();
		const request = sessionRequest();
		Object.defineProperty(request, "preferSecretless", { value: false });
		expect(await codeOfAsync(() => gw.brokerSession(request))).toBe(
			"secretless-required",
		);
	});
});

describe("isolation-class bridging", () => {
	test("a target in another class is refused and the denial is recorded", async () => {
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
			expect(expected).toBeTruthy();
		}
	});
});

describe("elevated capability for production", () => {
	test("a production session with no elevated token is refused", async () => {
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
					elevatedToken: elevatedToken("production"),
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
		const staging = elevatedToken("staging");
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

	test("a token minted under a different secret is refused", async () => {
		const foreign = elevatedToken("production", {
			hmacSecret: "some-other-secret",
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
		const gw = await started("development");
		await expect(gw.brokerSession(sessionRequest())).resolves.toBeDefined();
	});

	test("a class named in capabilityRequiredClasses also requires a token", async () => {
		const gw = await started("staging", {
			capabilityRequiredClasses: ["staging"],
		});
		expect(await codeOfAsync(() => gw.brokerSession(sessionRequest()))).toBe(
			"elevated-required",
		);
	});

	test("production requires a token even when the configured list omits it", async () => {
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
		const gw = await started();
		const handle = await gw.brokerSession(sessionRequest());
		const verified = gw.verifyLocalSession(handle.sessionToken);
		expect(verified.ok).toBe(true);
	});

	test("a token from one gateway does not verify against another", async () => {
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
		const gw = await started();
		expect(await codeOfAsync(() => gw.renewSession("pam_native_ghost"))).toBe(
			"session-missing",
		);
	});

	test("renewing records an audit event naming the original subject", async () => {
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
			code = String((error as { code?: unknown }).code);
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
			code = String((error as { code?: unknown }).code);
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
		expect(railEnablesPam([], { privilegedAccessGateway: "yes" })).toBe(false);
		expect(railEnablesPam([], { privilegedAccessGateway: "false" })).toBe(
			false,
		);
	});

	test("the exact capability pack enables it", () => {
		expect(railEnablesPam(["capability:privileged-access-gateway"])).toBe(true);
	});

	test("a pack merely mentioning privileged-access enables it", () => {
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
		const captured: Array<{ type: string }> = [];
		const gw = await started("development", {
			auditSink: {
				async append(event: { type: string }) {
					captured.push(event);
				},
			} as never,
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
		const past = "2020-01-01T00:00:00.000Z";
		const gw = createPrivilegedAccessGateway({
			kind: "native",
			isolationClass: "development",
			now: () => past,
			elevatedHmacSecret: HMAC,
		});
		await gw.start(station("development"));
		const handle = await gw.brokerSession(sessionRequest());

		expect(handle.sessionToken).toBeTruthy();
		const verified = gw.verifyLocalSession(handle.sessionToken);
		expect(verified.ok).toBe(false);

		await gw.endSession(handle.sessionId, "done");
		const ended = gw.auditEvents.find((e) => e.type === "pam.SessionEnded");
		expect(ended?.subject).toBe("unknown");
	});
});
