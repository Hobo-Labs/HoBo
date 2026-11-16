/**
 * `connection.test.ts` walks the Connection aggregate's lifecycle: create,
 * authorize, list, get. That is the path a working system takes, and it is not
 * the path that matters most here — a Connection is a credential-bearing object,
 * so the interesting behaviour is every refusal: cross-tenant access, a subject
 * that does not own the Connection, scopes that exceed what was granted, and a
 * revoked Connection that must never mint another token.
 *
 * This file drives those refusals, plus the parts of the aggregate the lifecycle
 * test cannot reach: `resolveForToken`'s selection order when several candidate
 * Connections exist, and the event-fold that a crash resume depends on. Each
 * denial asserts its *code*, not just that something threw — the code is what a
 * caller branches on to decide whether to prompt for re-auth or hard-fail, so a
 * refusal with the wrong code is nearly as bad as no refusal at all.
 */
import { describe, expect, test } from "vitest";

import {
	type ConnectionEvent,
	type ConnectionPolicyGate,
	type ConnectionPrincipalRef,
	ConnectionService,
	createInMemoryVault,
	defaultConnectionPolicyGate,
	foldConnectionEvents,
} from "../src/index.js";

const TENANT = "tenant-a";
const STATION = "station:test";
const ALICE: ConnectionPrincipalRef = { kind: "user", id: "user:alice" };
const BOB: ConnectionPrincipalRef = { kind: "user", id: "user:bob" };
const SYSTEM: ConnectionPrincipalRef = { kind: "system", id: "svc:broker" };

function vault() {
	return createInMemoryVault({
		reference: "vaultref://test/root",
		rootSecret: "fixture-connection-root-DO-NOT-SHIP",
	});
}

function service(overrides: { policyGate?: ConnectionPolicyGate } = {}) {
	return new ConnectionService({
		tenant: TENANT,
		vault: vault(),
		...overrides,
	});
}

/** Create a connection and, unless told otherwise, authorize it. */
function connected(
	svc: ConnectionService,
	options: {
		provider?: string;
		alias?: string;
		subject?: ConnectionPrincipalRef;
		scopes?: readonly string[];
		grantedScopes?: readonly string[];
		authorize?: boolean;
	} = {},
) {
	const subject = options.subject ?? ALICE;
	const createInput = {
		provider: options.provider ?? "asana",
		subject,
		createdBy: subject,
		scopes: options.scopes ?? ["tasks:read"],
		stationId: STATION,
	};
	if (options.alias !== undefined) createInput.alias = options.alias;
	const { connection } = svc.create(createInput);
	if (options.authorize === false) return connection;
	const authorizeInput = {
		idOrAlias: connection.id,
		actor: subject,
	};
	if (options.grantedScopes !== undefined)
		authorizeInput.grantedScopes = options.grantedScopes;
	return svc.authorize(authorizeInput).connection;
}

/** Assert a thrown error carries the expected machine-readable code. */
function codeOf(fn: () => void): string {
	try {
		fn();
	} catch (error) {
		// SAFETY: service errors expose a string `code`; non-error throws use the fallback.
		const coded = error as { code?: unknown };
		const code = coded.code;
		return String(code) === code ? String(code) : `<no code: ${String(error)}>`;
	}
	return "<did not throw>";
}

describe("create refusals", () => {
	test("a missing stationId is refused with a station-required code", () => {
		// A Station owns its Connections; one created without an owner would be
		// unreachable from the control plane and impossible to revoke through it.
		const svc = service();
		expect(
			codeOf(() =>
				svc.create({
					provider: "asana",
					subject: ALICE,
					createdBy: ALICE,
					stationId: "",
				}),
			),
		).toBe("connection-station-required");
	});

	test("a non-string stationId is refused too", () => {
		// The type says string, but this object arrives across a wire boundary
		// where the type is only a claim.
		const svc = service();
		expect(
			codeOf(() =>
				svc.create({
					provider: "asana",
					subject: ALICE,
					createdBy: ALICE,
					// SAFETY: this deliberately crosses the runtime input boundary to test refusal.
					// oxlint-disable-next-line anti-slop/no-chained-type-assertions
					stationId: undefined as unknown as string,
				}),
			),
		).toBe("connection-station-required");
	});

	test("a duplicate alias is refused rather than silently rebinding", () => {
		// The alias index maps one name to one id. A silent rebind would leave the
		// first Connection alive but unreachable by the name its owner uses.
		const svc = service();
		connected(svc, { alias: "work", authorize: false });
		expect(
			codeOf(() =>
				svc.create({
					provider: "asana",
					alias: "work",
					subject: ALICE,
					createdBy: ALICE,
					stationId: STATION,
				}),
			),
		).toBe("connection-alias-conflict");
	});

	test("the same alias is free again for a different service instance", () => {
		// The index is per-service, not global; asserting this keeps a future
		// change to a shared index from passing unnoticed.
		const first = service();
		connected(first, { alias: "work", authorize: false });
		const second = service();
		expect(() =>
			second.create({
				provider: "asana",
				alias: "work",
				subject: ALICE,
				createdBy: ALICE,
				stationId: STATION,
			}),
		).not.toThrow();
	});

	test("a create denied by the policy gate throws the gate's own code", () => {
		// The gate's reason and code are what surface to the caller; swallowing
		// them and throwing something generic would lose the remediation.
		const svc = service({
			policyGate: () => ({
				allow: false,
				reason: "no create grant",
				code: "custom-denied",
			}),
		});
		expect(
			codeOf(() =>
				svc.create({
					provider: "asana",
					subject: ALICE,
					createdBy: ALICE,
					stationId: STATION,
				}),
			),
		).toBe("custom-denied");
	});

	test("a created connection starts pending with no credential reference", () => {
		// A Connection that looked active before authorization would let
		// resolveForToken hand out a token backed by nothing.
		const svc = service();
		const connection = connected(svc, { authorize: false });
		expect(connection.status).toBe("pending");
		expect(connection.credentialRef).toBeUndefined();
		expect(connection.grantedScopes).toEqual([]);
	});

	test("the flow defaults to oauth2-obo", () => {
		expect(connected(service(), { authorize: false }).flow).toBe("oauth2-obo");
	});

	test("an explicit flow is preserved", () => {
		const svc = service();
		const { connection } = svc.create({
			provider: "gh",
			flow: "app-install",
			subject: ALICE,
			createdBy: ALICE,
			stationId: STATION,
		});
		expect(connection.flow).toBe("app-install");
	});

	test("ids are unique and namespaced", () => {
		const svc = service();
		const ids = new Set(
			Array.from({ length: 25 }, () => connected(svc, { authorize: false }).id),
		);
		expect(ids.size).toBe(25);
		for (const id of ids) expect(id).toMatch(/^conn_[0-9a-f]{16}$/);
	});
});

describe("the default policy gate", () => {
	test("it denies a create with no subject id", () => {
		const decision = defaultConnectionPolicyGate({
			subject: { kind: "user", id: "" },
			action: "connection.create",
			tenant: TENANT,
		});
		expect(decision).toEqual({
			allow: false,
			reason: "subject required",
			code: "connection-policy-denied",
		});
	});

	test("it allows a create for an identified subject", () => {
		expect(
			defaultConnectionPolicyGate({
				subject: ALICE,
				action: "connection.create",
				tenant: TENANT,
			}).allow,
		).toBe(true);
	});

	test("it defers the non-create actions to the service's own checks", () => {
		// The gate is deliberately permissive here — ownership and tenancy are
		// enforced by ConnectionService, not by the default gate. Pinning that
		// keeps someone from reading the `allow: true` as a security guarantee.
		for (const action of [
			"connection.use",
			"connection.authorize",
			"connection.revoke",
			"connection.rotate",
		] as const) {
			expect(
				defaultConnectionPolicyGate({
					subject: { kind: "user", id: "" },
					action,
					tenant: TENANT,
				}).allow,
			).toBe(true);
		}
	});
});

describe("ownership and tenancy guards", () => {
	test("a stranger cannot authorize someone else's connection", () => {
		const svc = service();
		const connection = connected(svc, { authorize: false });
		expect(
			codeOf(() => svc.authorize({ idOrAlias: connection.id, actor: BOB })),
		).toBe("connection-forbidden");
	});

	test("a stranger cannot revoke someone else's connection", () => {
		// Revocation by a stranger would be a denial-of-service against the owner.
		const svc = service();
		const connection = connected(svc);
		expect(
			codeOf(() =>
				svc.revoke({ idOrAlias: connection.id, actor: BOB, reason: "nope" }),
			),
		).toBe("connection-forbidden");
	});

	test("a stranger cannot rotate someone else's connection", () => {
		const svc = service();
		const connection = connected(svc);
		expect(
			codeOf(() => svc.rotate({ idOrAlias: connection.id, actor: BOB })),
		).toBe("connection-forbidden");
	});

	test("the creator may manage a connection whose subject is someone else", () => {
		// Delegated setup is a real flow — an admin creates a Connection whose
		// subject is a service principal and must still be able to rotate it.
		const svc = service();
		const { connection } = svc.create({
			provider: "asana",
			subject: BOB,
			createdBy: ALICE,
			stationId: STATION,
		});
		expect(() =>
			svc.authorize({ idOrAlias: connection.id, actor: ALICE }),
		).not.toThrow();
	});

	test("a system principal bypasses the ownership check", () => {
		// The broker acts on connections it does not own; without this it could
		// not refresh anything on a user's behalf.
		const svc = service();
		const connection = connected(svc);
		expect(() =>
			svc.rotate({ idOrAlias: connection.id, actor: SYSTEM }),
		).not.toThrow();
	});

	test("managing a connection from another tenant is refused", () => {
		// The record's tenant is stamped at creation. Rebuilding the service under
		// a different tenant must not grant it authority over those records.
		const events: ConnectionEvent[] = [];
		const home = new ConnectionService({
			tenant: TENANT,
			vault: vault(),
		});
		const connection = connected(home);
		events.push(...home.events);

		const foreign = ConnectionService.fromEvents(events, {
			tenant: "tenant-b",
			vault: vault(),
		});
		expect(
			codeOf(() =>
				foreign.revoke({
					idOrAlias: connection.id,
					actor: ALICE,
					reason: "x",
				}),
			),
		).toBe("connection-cross-tenant");
	});

	test("every management verb refuses an unknown id with the same code", () => {
		// A caller retries on not-found and hard-fails on forbidden; the two must
		// not be conflated by any one verb.
		const svc = service();
		expect(
			codeOf(() => svc.authorize({ idOrAlias: "ghost", actor: ALICE })),
		).toBe("connection-not-found");
		expect(
			codeOf(() =>
				svc.revoke({ idOrAlias: "ghost", actor: ALICE, reason: "x" }),
			),
		).toBe("connection-not-found");
		expect(codeOf(() => svc.rotate({ idOrAlias: "ghost", actor: ALICE }))).toBe(
			"connection-not-found",
		);
		expect(
			codeOf(() => svc.markNeedsReauth({ idOrAlias: "ghost", reason: "x" })),
		).toBe("connection-not-found");
	});

	test("a policy-gate denial on authorize surfaces the gate's code", () => {
		const svc = service({
			policyGate: (input) =>
				input.action === "connection.authorize"
					? { allow: false, reason: "denied", code: "gate-no-authorize" }
					: { allow: true },
		});
		const connection = connected(svc, { authorize: false });
		expect(
			codeOf(() => svc.authorize({ idOrAlias: connection.id, actor: ALICE })),
		).toBe("gate-no-authorize");
	});

	test("a policy-gate denial on revoke surfaces the gate's code", () => {
		const svc = service({
			policyGate: (input) =>
				input.action === "connection.revoke"
					? { allow: false, reason: "denied", code: "gate-no-revoke" }
					: { allow: true },
		});
		const connection = connected(svc);
		expect(
			codeOf(() =>
				svc.revoke({ idOrAlias: connection.id, actor: ALICE, reason: "x" }),
			),
		).toBe("gate-no-revoke");
	});

	test("a policy-gate denial on rotate surfaces the gate's code", () => {
		const svc = service({
			policyGate: (input) =>
				input.action === "connection.rotate"
					? { allow: false, reason: "denied", code: "gate-no-rotate" }
					: { allow: true },
		});
		const connection = connected(svc);
		expect(
			codeOf(() => svc.rotate({ idOrAlias: connection.id, actor: ALICE })),
		).toBe("gate-no-rotate");
	});
});

describe("authorize", () => {
	test("granted scopes default to the requested scopes", () => {
		const svc = service();
		const connection = connected(svc, { scopes: ["a", "b"] });
		expect(connection.grantedScopes).toEqual(["a", "b"]);
	});

	test("explicitly granted scopes narrow the requested set", () => {
		// A provider that grants less than was asked for is the common case; the
		// record must reflect what was actually granted or the ceiling is wrong.
		const svc = service();
		const connection = connected(svc, {
			scopes: ["a", "b"],
			grantedScopes: ["a"],
		});
		expect(connection.grantedScopes).toEqual(["a"]);
		expect(connection.requestedScopes).toEqual(["a", "b"]);
	});

	test("the credential reference is a vault pointer, not the secret", () => {
		// The whole point of the vault indirection: nothing derived from the root
		// secret may appear in a record that gets logged or projected.
		const svc = service();
		const connection = connected(svc);
		expect(connection.credentialRef).toMatch(
			new RegExp(`^vaultref://connection/${connection.id}/[0-9a-f]{16}$`),
		);
	});

	test("no event carries the authorize secret", () => {
		// The secret is folded into vault material only. If it leaked into an
		// event it would be permanently in an append-only, never-compacted log.
		const svc = service();
		const { connection } = svc.create({
			provider: "asana",
			subject: ALICE,
			createdBy: ALICE,
			stationId: STATION,
		});
		svc.authorize({
			idOrAlias: connection.id,
			actor: ALICE,
			authorizeSecret: "SUPER-SECRET-VALUE",
		});
		expect(JSON.stringify(svc.events)).not.toContain("SUPER-SECRET-VALUE");
	});

	test("a different authorize secret yields a different credential reference", () => {
		// Otherwise the reference would not actually be bound to the material and
		// two distinct grants would collide in the vault.
		const svc = service();
		const first = svc.create({
			provider: "asana",
			subject: ALICE,
			createdBy: ALICE,
			stationId: STATION,
		}).connection;
		const second = svc.create({
			provider: "asana",
			subject: ALICE,
			createdBy: ALICE,
			stationId: STATION,
		}).connection;
		const a = svc.authorize({
			idOrAlias: first.id,
			actor: ALICE,
			authorizeSecret: "one",
		}).connection.credentialRef;
		const b = svc.authorize({
			idOrAlias: second.id,
			actor: ALICE,
			authorizeSecret: "two",
		}).connection.credentialRef;
		expect(a).not.toBe(b);
	});

	test("authorize emits both AuthorizationStarted and Authorized", () => {
		// The started event is the audit anchor for a flow that may never
		// complete; without it a half-finished authorization leaves no trace.
		const svc = service();
		const connection = connected(svc, { authorize: false });
		const { events } = svc.authorize({
			idOrAlias: connection.id,
			actor: ALICE,
		});
		expect(events.map((e) => e.type)).toEqual([
			"connection.AuthorizationStarted",
			"connection.Authorized",
		]);
	});

	test("an installation id is recorded when supplied and absent otherwise", () => {
		const svc = service();
		const withId = svc.authorize({
			idOrAlias: connected(svc, { authorize: false }).id,
			actor: ALICE,
			installationId: "install-1",
		}).connection;
		expect(withId.installationId).toBe("install-1");

		const without = connected(svc, { authorize: false });
		const plain = svc.authorize({
			idOrAlias: without.id,
			actor: ALICE,
		}).connection;
		expect("installationId" in plain).toBe(false);
	});

	test("authorize resolves by alias as well as by id", () => {
		const svc = service();
		connected(svc, { alias: "work", authorize: false });
		expect(
			svc.authorize({ idOrAlias: "work", actor: ALICE }).connection.status,
		).toBe("active");
	});
});

describe("revoke and rotate", () => {
	test("revoking marks the connection revoked", () => {
		const svc = service();
		const connection = connected(svc);
		const { connection: revoked } = svc.revoke({
			idOrAlias: connection.id,
			actor: ALICE,
			reason: "user left",
		});
		expect(revoked.status).toBe("revoked");
	});

	test("a revoked connection cannot be rotated", () => {
		// Rotation on a revoked Connection would mint fresh vault material for a
		// credential that was deliberately killed.
		const svc = service();
		const connection = connected(svc);
		svc.revoke({ idOrAlias: connection.id, actor: ALICE, reason: "x" });
		expect(
			codeOf(() => svc.rotate({ idOrAlias: connection.id, actor: ALICE })),
		).toBe("connection-revoked");
	});

	test("rotating replaces the credential reference and records the previous one", () => {
		// The previous reference is what lets an operator confirm the old material
		// was superseded rather than merely duplicated.
		const svc = service();
		const connection = connected(svc);
		const before = connection.credentialRef;
		const { connection: rotated, events } = svc.rotate({
			idOrAlias: connection.id,
			actor: ALICE,
		});
		expect(rotated.credentialRef).not.toBe(before);
		expect(events[0]?.data.previousCredentialRef).toBe(before);
	});

	test("rotating a never-authorized connection records a sentinel previous ref", () => {
		// There is no prior credential, and `undefined` in an append-only audit
		// event would be indistinguishable from a dropped field.
		const svc = service();
		const connection = connected(svc, { authorize: false });
		const { events } = svc.rotate({ idOrAlias: connection.id, actor: ALICE });
		expect(events[0]?.data.previousCredentialRef).toBe("vaultref://none");
	});

	test("rotating a pending connection makes it active", () => {
		const svc = service();
		const connection = connected(svc, { authorize: false });
		expect(
			svc.rotate({ idOrAlias: connection.id, actor: ALICE }).connection.status,
		).toBe("active");
	});

	test("markNeedsReauth sets the status and records the reason as health", () => {
		// The reason is what the CLI shows the user; losing it leaves them with
		// "needs re-auth" and no idea why.
		const svc = service();
		const connection = connected(svc);
		const { connection: flagged } = svc.markNeedsReauth({
			idOrAlias: connection.id,
			reason: "refresh token expired",
		});
		expect(flagged.status).toBe("needs-reauth");
		expect(flagged.metadata.health).toBe("refresh token expired");
	});

	test("re-authorizing clears the needs-reauth status", () => {
		const svc = service();
		const connection = connected(svc);
		svc.markNeedsReauth({ idOrAlias: connection.id, reason: "expired" });
		expect(
			svc.authorize({ idOrAlias: connection.id, actor: ALICE }).connection
				.status,
		).toBe("active");
	});
});

describe("resolveForToken", () => {
	const SCOPES = ["tasks:read"];

	test("an explicit id that does not exist is denied as not-found", () => {
		const result = service().resolveForToken({
			idOrAlias: "ghost",
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status).toBe("denied");
		expect(result.status === "denied" && result.code).toBe(
			"connection-not-found",
		);
	});

	test("a not-found denial names commands the user can actually run", () => {
		// The remediation array is rendered straight into the CLI error; empty or
		// generic text there is the difference between a fixable and a dead end.
		const result = service().resolveForToken({
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(
			result.status === "denied" && result.remediation.length,
		).toBeGreaterThan(0);
		expect(
			result.status === "denied" && result.remediation.join(" "),
		).toContain("asana");
	});

	test("a revoked connection is denied with the revoked code", () => {
		const svc = service();
		const connection = connected(svc);
		svc.revoke({ idOrAlias: connection.id, actor: ALICE, reason: "x" });
		const result = svc.resolveForToken({
			idOrAlias: connection.id,
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-revoked",
		);
	});

	test("a needs-reauth connection is denied with an actionable authorize command", () => {
		// This denial is recoverable, and the caller distinguishes it from a hard
		// failure purely by the code.
		const svc = service();
		const connection = connected(svc, { alias: "work" });
		svc.markNeedsReauth({ idOrAlias: connection.id, reason: "expired" });
		const result = svc.resolveForToken({
			idOrAlias: "work",
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-needs-reauth",
		);
		expect(result.status === "denied" && result.remediation[0]).toContain(
			"work",
		);
	});

	test("a pending connection is denied as not-active", () => {
		// Distinct from needs-reauth: nothing expired, it was simply never
		// authorized, and the operator needs to know which of the two it is.
		const svc = service();
		const connection = connected(svc, { authorize: false });
		const result = svc.resolveForToken({
			idOrAlias: connection.id,
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-not-active",
		);
	});

	test("a provider mismatch on an explicitly named connection is denied", () => {
		// Naming a Connection explicitly must not override which provider it is
		// for — that would hand a Slack token to a caller asking for GitHub.
		const svc = service();
		const _connection = connected(svc, { provider: "asana", alias: "work" });
		const result = svc.resolveForToken({
			idOrAlias: "work",
			provider: "github",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-provider-mismatch",
		);
	});

	test("requesting a scope outside the granted ceiling is denied as escalation", () => {
		// This is the privilege-escalation guard: a Connection granted read must
		// never back a write token.
		const svc = service();
		const connection = connected(svc, {
			scopes: ["tasks:read", "tasks:write"],
			grantedScopes: ["tasks:read"],
		});
		const result = svc.resolveForToken({
			idOrAlias: connection.id,
			provider: "asana",
			subject: ALICE,
			scopes: ["tasks:write"],
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-scope-escalation",
		);
		expect(
			result.status === "denied" && result.remediation.join(" "),
		).toContain("tasks:read");
	});

	test("an empty scope request is always within the ceiling", () => {
		// Asking for nothing cannot be an escalation, even against an empty
		// ceiling; refusing it would break the "just identify me" case.
		const svc = service();
		const connection = connected(svc, { scopes: [], grantedScopes: [] });
		const result = svc.resolveForToken({
			idOrAlias: connection.id,
			provider: "asana",
			subject: ALICE,
			scopes: [],
		});
		expect(result.status).toBe("ok");
	});

	test("any scope against an empty ceiling is refused", () => {
		// An empty grantedScopes is not a wildcard. Reading it as one would make
		// an unscoped Connection the most powerful kind.
		const svc = service();
		const connection = connected(svc, { scopes: [], grantedScopes: [] });
		const result = svc.resolveForToken({
			idOrAlias: connection.id,
			provider: "asana",
			subject: ALICE,
			scopes: ["tasks:read"],
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-scope-escalation",
		);
	});

	test("a connection bound to another subject is refused", () => {
		const svc = service();
		const connection = connected(svc, { subject: ALICE });
		const result = svc.resolveForToken({
			idOrAlias: connection.id,
			provider: "asana",
			subject: BOB,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-subject-mismatch",
		);
	});

	test("a system principal may use a connection bound to a user", () => {
		// The broker refreshes on the user's behalf; without this exemption
		// background refresh could not work at all.
		const svc = service();
		const connection = connected(svc, { subject: ALICE });
		const result = svc.resolveForToken({
			idOrAlias: connection.id,
			provider: "asana",
			subject: SYSTEM,
			scopes: SCOPES,
		});
		expect(result.status).toBe("ok");
	});

	test("a cross-tenant connection is denied before any other check", () => {
		// Tenancy is the outermost boundary; leaking even the *reason* a
		// cross-tenant Connection was rejected would confirm it exists.
		const home = service();
		const connection = connected(home);
		const foreign = ConnectionService.fromEvents(home.events, {
			tenant: "tenant-b",
			vault: vault(),
		});
		const result = foreign.resolveForToken({
			idOrAlias: connection.id,
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-cross-tenant",
		);
	});

	test("a policy-gate denial on use surfaces the gate's code and reason", () => {
		const svc = service({
			policyGate: (input) =>
				input.action === "connection.use"
					? { allow: false, reason: "no use grant", code: "gate-no-use" }
					: { allow: true },
		});
		const connection = connected(svc);
		const result = svc.resolveForToken({
			idOrAlias: connection.id,
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe("gate-no-use");
		expect(result.status === "denied" && result.reason).toBe("no use grant");
	});

	test("without an explicit id an active connection is preferred over needs-reauth", () => {
		// Selection order is what keeps a healthy Connection from being passed
		// over in favour of a broken one that happens to sort first.
		const svc = service();
		const broken = connected(svc, { alias: "broken" });
		svc.markNeedsReauth({ idOrAlias: broken.id, reason: "expired" });
		const healthy = connected(svc, { alias: "healthy" });

		const result = svc.resolveForToken({
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status).toBe("ok");
		expect(result.status === "ok" && result.connection.id).toBe(healthy.id);
	});

	test("a needs-reauth connection is chosen over a pending one", () => {
		// Both are unusable, but needs-reauth yields the recoverable denial with
		// an authorize command, which is the more useful thing to tell the user.
		const svc = service();
		const pending = connected(svc, { authorize: false });
		const stale = connected(svc);
		svc.markNeedsReauth({ idOrAlias: stale.id, reason: "expired" });

		const result = svc.resolveForToken({
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-needs-reauth",
		);
		expect(pending.status).toBe("pending");
	});

	test("candidates are filtered by scope before the status preference applies", () => {
		// An active Connection that cannot cover the scopes is not a candidate at
		// all; picking it would produce an escalation denial instead of using the
		// narrower-status Connection that actually can.
		const svc = service();
		connected(svc, { scopes: ["other"], grantedScopes: ["other"] });
		const capable = connected(svc, {
			scopes: ["tasks:read"],
			grantedScopes: ["tasks:read"],
		});
		const result = svc.resolveForToken({
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "ok" && result.connection.id).toBe(capable.id);
	});

	test("a pending candidate is matched on its requested scopes", () => {
		// It has no granted scopes yet, so filtering on those alone would make
		// every pending Connection invisible to selection.
		const svc = service();
		const pending = connected(svc, {
			scopes: ["tasks:read"],
			authorize: false,
		});
		const result = svc.resolveForToken({
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-not-active",
		);
		expect(pending.grantedScopes).toEqual([]);
	});

	test("another subject's connection is not a candidate for implicit selection", () => {
		const svc = service();
		connected(svc, { subject: BOB });
		const result = svc.resolveForToken({
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-not-found",
		);
	});

	test("another provider's connection is not a candidate", () => {
		const svc = service();
		connected(svc, { provider: "github" });
		const result = svc.resolveForToken({
			provider: "asana",
			subject: ALICE,
			scopes: SCOPES,
		});
		expect(result.status === "denied" && result.code).toBe(
			"connection-not-found",
		);
	});
});

describe("list", () => {
	test("results are sorted by id so a projection is stable", () => {
		const svc = service();
		for (let i = 0; i < 5; i++) connected(svc, { authorize: false });
		const ids = svc.list().map((c) => c.id);
		expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
	});

	test("filters compose", () => {
		const svc = service();
		connected(svc, { provider: "asana", subject: ALICE });
		connected(svc, { provider: "github", subject: ALICE });
		connected(svc, { provider: "asana", subject: BOB });

		expect(svc.list({ provider: "asana" })).toHaveLength(2);
		expect(svc.list({ subjectId: BOB.id })).toHaveLength(1);
		expect(
			svc.list({ provider: "asana", subjectId: ALICE.id, status: "active" }),
		).toHaveLength(1);
	});

	test("an empty filter object returns everything", () => {
		// Each filter branch guards on truthiness, so an absent field must not be
		// read as "match nothing".
		const svc = service();
		connected(svc, { authorize: false });
		expect(svc.list({})).toHaveLength(1);
	});

	test("a status filter that matches nothing returns an empty list", () => {
		const svc = service();
		connected(svc, { authorize: false });
		expect(svc.list({ status: "revoked" })).toHaveLength(0);
	});

	test("get resolves by alias and by id, and misses cleanly", () => {
		const svc = service();
		const connection = connected(svc, { alias: "work", authorize: false });
		expect(svc.get("work")?.id).toBe(connection.id);
		expect(svc.get(connection.id)?.id).toBe(connection.id);
		expect(svc.get("neither")).toBeUndefined();
	});
});

describe("rebuilding from events", () => {
	test("a rebuilt service reproduces the live one exactly", () => {
		// This is the crash-resume path. If the fold diverges, a restart silently
		// changes who can use which credential.
		const live = service();
		const first = connected(live, { alias: "work", scopes: ["a", "b"] });
		const second = connected(live, { provider: "github" });
		live.markNeedsReauth({ idOrAlias: second.id, reason: "expired" });
		live.rotate({ idOrAlias: first.id, actor: ALICE });
		live.recordTokenIssued({
			connectionId: first.id,
			grantId: "g-1",
			tokenRef: "tok-1",
			scopes: ["a"],
			expiresAt: "2026-01-01T00:00:00.000Z",
		});

		const rebuilt = ConnectionService.fromEvents(live.events, {
			tenant: TENANT,
			vault: vault(),
		});
		expect(rebuilt.list()).toEqual(live.list());
	});

	test("the rebuilt sequence continues past the replayed events", () => {
		// Restarting at zero would emit events whose seq collides with history,
		// making the log unorderable.
		const live = service();
		connected(live);
		const highest = Math.max(...live.events.map((e) => e.seq));
		const rebuilt = ConnectionService.fromEvents(live.events, {
			tenant: TENANT,
			vault: vault(),
		});
		const next = connected(rebuilt, { provider: "github", authorize: false });
		expect(next.seq).toBeGreaterThan(highest);
	});

	test("the alias index is rebuilt, not just the id map", () => {
		const live = service();
		connected(live, { alias: "work" });
		const rebuilt = ConnectionService.fromEvents(live.events, {
			tenant: TENANT,
			vault: vault(),
		});
		expect(rebuilt.get("work")).toBeDefined();
	});

	test("an event for an unknown connection is ignored rather than throwing", () => {
		// A partial log — one truncated before its Created event — must still
		// replay. Throwing here would make the whole service unrecoverable.
		const live = service();
		const connection = connected(live);
		const withoutCreated = live.events.filter(
			(e) => e.type !== "connection.Created",
		);
		expect(withoutCreated.length).toBeGreaterThan(0);
		const rebuilt = ConnectionService.fromEvents(withoutCreated, {
			tenant: TENANT,
			vault: vault(),
		});
		expect(rebuilt.list()).toHaveLength(0);
		expect(connection.status).toBe("active");
	});

	test("a Created event missing its stationId is refused during replay", () => {
		// The invariant holds on the replay path too — otherwise a log written
		// before the requirement existed would resurrect ownerless Connections.
		const live = service();
		connected(live, { authorize: false });
		const created = live.events[0];
		expect(created).toBeDefined();
		if (!created) throw new Error("expected a Created event");
		// SAFETY: `created` is the first event emitted by `connected` and is a Created event.
		const createdEvent = created as ConnectionEvent;
		// SAFETY: the copied event retains the ConnectionEvent discriminant.
		const corrupted = [
			{
				...createdEvent,
				data: { ...createdEvent.data, stationId: "" },
			} as ConnectionEvent,
		];
		expect(() =>
			ConnectionService.fromEvents(corrupted, {
				tenant: TENANT,
				vault: vault(),
			}),
		).toThrow(/stationId/);
	});

	test("foldConnectionEvents produces the same views as a rebuilt service", () => {
		const live = service();
		connected(live, { alias: "work" });
		connected(live, { provider: "github", authorize: false });
		expect(
			foldConnectionEvents(live.events, { tenant: TENANT, vault: vault() }),
		).toEqual(live.list());
	});

	test("folding an empty log yields no connections", () => {
		expect(
			foldConnectionEvents([], { tenant: TENANT, vault: vault() }),
		).toHaveLength(0);
	});

	test("recordTokenIssued stamps lastUsedAt without changing status", () => {
		// lastUsedAt drives idle-revocation policy; a token issue that did not
		// touch it would make an actively used Connection look abandoned.
		const svc = new ConnectionService({
			tenant: TENANT,
			vault: vault(),
			now: () => "2026-03-03T00:00:00.000Z",
		});
		const connection = connected(svc);
		expect(connection.metadata.lastUsedAt).toBeUndefined();
		svc.recordTokenIssued({
			connectionId: connection.id,
			grantId: "g-1",
			tokenRef: "tok-1",
			scopes: ["tasks:read"],
			expiresAt: "2026-03-03T01:00:00.000Z",
		});
		const after = svc.get(connection.id);
		expect(after?.metadata.lastUsedAt).toBe("2026-03-03T00:00:00.000Z");
		expect(after?.status).toBe("active");
	});

	test("every event the service emits carries never-compact retention", () => {
		// These are credential-audit records. If compaction could drop them, the
		// log could not answer who authorized what.
		const svc = service();
		const connection = connected(svc, { alias: "work" });
		svc.rotate({ idOrAlias: connection.id, actor: ALICE });
		svc.markNeedsReauth({ idOrAlias: connection.id, reason: "x" });
		svc.revoke({ idOrAlias: connection.id, actor: ALICE, reason: "done" });
		expect(svc.events.length).toBeGreaterThan(4);
		for (const event of svc.events) {
			expect(event.retention.neverCompact).toBe(true);
		}
	});

	test("records and the lists that contain them are frozen", () => {
		const svc = service();
		connected(svc, { authorize: false });
		const list = svc.list();
		expect(Object.isFrozen(list)).toBe(true);
		expect(Object.isFrozen(list[0])).toBe(true);
	});
});
