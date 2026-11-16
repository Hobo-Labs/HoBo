import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	type ActiveSvidRecord,
	ConnectionService,
	createInMemoryVault,
	TokenBroker,
} from "../src/index.js";

const TENANT = "tenant-a";
const USER = { kind: "user" as const, id: "user:alice" };
const STATION = "station:test";

function vault() {
	return createInMemoryVault({
		reference: "vaultref://test/root",
		rootSecret: "fixture-connection-root-DO-NOT-SHIP",
	});
}

function service() {
	return new ConnectionService({ tenant: TENANT, vault: vault() });
}

describe("first-class Connection aggregate", () => {
	it("create → authorize → list → get lifecycle", () => {
		const svc = service();
		const { connection: created } = svc.create({
			provider: "asana",
			alias: "work",
			subject: USER,
			createdBy: USER,
			scopes: ["tasks:read", "tasks:write"],
			stationId: STATION,
		});
		expect(created.status).toBe("pending");
		expect(created.credentialRef).toBeUndefined();

		const { connection: active } = svc.authorize({
			idOrAlias: "work",
			actor: USER,
			installationId: "asana-ws-1",
		});
		expect(active.status).toBe("active");
		expect(active.credentialRef).toMatch(/^vaultref:\/\/connection\//);
		expect(active.grantedScopes).toEqual(["tasks:read", "tasks:write"]);
		// Secret never appears in events.
		for (const e of svc.events) {
			const json = JSON.stringify(e);
			expect(json).not.toMatch(/fixture-connection-root/);
			expect(json).not.toMatch(/client_secret|refresh_token|password/i);
		}

		expect(svc.list({ provider: "asana" })).toHaveLength(1);
		expect(svc.get("work")?.id).toBe(created.id);
		expect(svc.get(created.id)?.alias).toBe("work");
	});

	it("rebuilds from events (event-sourced)", () => {
		const svc = service();
		svc.create({
			provider: "slack",
			alias: "ops",
			subject: USER,
			createdBy: USER,
			scopes: ["chat:write"],
			stationId: STATION,
		});
		svc.authorize({ idOrAlias: "ops", actor: USER });
		const rebuilt = ConnectionService.fromEvents(svc.events, {
			tenant: TENANT,
			vault: vault(),
		});
		expect(rebuilt.get("ops")?.status).toBe("active");
		expect(rebuilt.list()).toHaveLength(1);
	});

	it("revocation is enforced for token resolution", () => {
		const svc = service();
		svc.create({
			provider: "asana",
			alias: "work",
			subject: USER,
			createdBy: USER,
			scopes: ["tasks:read"],
			stationId: STATION,
		});
		svc.authorize({ idOrAlias: "work", actor: USER });
		svc.revoke({ idOrAlias: "work", actor: USER, reason: "compromised" });
		const resolved = svc.resolveForToken({
			idOrAlias: "work",
			provider: "asana",
			subject: USER,
			scopes: ["tasks:read"],
		});
		expect(resolved.status).toBe("denied");
		if (resolved.status === "denied") {
			expect(resolved.code).toBe("connection-revoked");
		}
	});

	it("needs-reauth is actionable", () => {
		const svc = service();
		svc.create({
			provider: "asana",
			alias: "work",
			subject: USER,
			createdBy: USER,
			scopes: ["tasks:read"],
			stationId: STATION,
		});
		svc.authorize({ idOrAlias: "work", actor: USER });
		svc.markNeedsReauth({
			idOrAlias: "work",
			reason: "provider-consent-expired",
		});
		const resolved = svc.resolveForToken({
			provider: "asana",
			subject: USER,
			scopes: ["tasks:read"],
		});
		expect(resolved.status).toBe("denied");
		if (resolved.status === "denied") {
			expect(resolved.code).toBe("connection-needs-reauth");
			expect(resolved.remediation.some((r) => r.includes("authorize"))).toBe(
				true,
			);
		}
	});

	it("rejects scope escalation beyond granted ceiling", () => {
		const svc = service();
		svc.create({
			provider: "asana",
			alias: "work",
			subject: USER,
			createdBy: USER,
			scopes: ["tasks:read"],
			stationId: STATION,
		});
		svc.authorize({
			idOrAlias: "work",
			actor: USER,
			grantedScopes: ["tasks:read"],
		});
		const resolved = svc.resolveForToken({
			idOrAlias: "work",
			provider: "asana",
			subject: USER,
			scopes: ["tasks:read", "tasks:write"],
		});
		expect(resolved.status).toBe("denied");
		if (resolved.status === "denied") {
			expect(resolved.code).toBe("connection-scope-escalation");
		}
	});

	it("rejects cross-subject confused-deputy use", () => {
		const svc = service();
		svc.create({
			provider: "asana",
			alias: "work",
			subject: USER,
			createdBy: USER,
			scopes: ["tasks:read"],
			stationId: STATION,
		});
		svc.authorize({ idOrAlias: "work", actor: USER });
		const resolved = svc.resolveForToken({
			idOrAlias: "work",
			provider: "asana",
			subject: { kind: "agent", id: "agent:evil" },
			scopes: ["tasks:read"],
		});
		expect(resolved.status).toBe("denied");
		if (resolved.status === "denied") {
			expect(resolved.code).toBe("connection-subject-mismatch");
		}
	});

	it("token broker mints connection-obo tokens with connectionId on grant", () => {
		const svc = service();
		svc.create({
			provider: "asana",
			alias: "work",
			subject: USER,
			createdBy: USER,
			scopes: ["tasks:read"],
			stationId: STATION,
		});
		const { connection } = svc.authorize({ idOrAlias: "work", actor: USER });

		const broker = new TokenBroker({
			vault: vault(),
			audience: "asana",
		});
		const svidBag = {
			identityId: "id-1",
			subject: `spiffe://hobo/${TENANT}/user/alice`,
			// SVID scope must authorize the grant scope (port/resource/verbs).
			scope: [
				{
					port: "hobo:connector",
					resource: "asana",
					verbs: ["call", "read", "write"],
				},
			],
			expiresAt: "2099-01-01T00:00:00.000Z",
			svidRef: "svidref://1",
		};
		// SAFETY: test fixture is an ActiveSvidRecord at this broker grant boundary.
		const svid = svidBag as ActiveSvidRecord;

		const grant = broker.grantForDeploy({
			svid,
			scope: {
				port: "hobo:connector",
				resource: "asana",
				action: "call",
			},
			deployId: "deploy-1",
			connectionId: connection.id,
			connectionCredentialRef: must(
				connection.credentialRef,
				"connection.credentialRef",
			),
			connectionProvider: "asana",
		});
		expect(grant.status).toBe("granted");
		if (grant.status === "granted") {
			expect(grant.grant.credentialSource).toBe("connection-obo");
			expect(grant.grant.connectionId).toBe(connection.id);
			expect(grant.events[0]?.data.connectionId).toBe(connection.id);
		}

		const connEvent = svc.recordTokenIssued({
			connectionId: connection.id,
			grantId: grant.status === "granted" ? grant.grant.grantId : "x",
			tokenRef: grant.status === "granted" ? grant.grant.tokenRef : "x",
			scopes: ["tasks:read"],
			expiresAt:
				grant.status === "granted"
					? grant.grant.expiresAt
					: "2099-01-01T00:00:00.000Z",
		});
		expect(connEvent.type).toBe("connection.TokenIssued");
	});
});
