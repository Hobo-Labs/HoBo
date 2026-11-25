/**
 * Executable proof: mediated residual secrets never reach the workload
 * (ADR-0027 mediation + ADR-0130 named endpoints).
 */
import { describe, expect, it } from "vitest";

import {
	createSecretlessConnector,
	openMysqlSecretlessLease,
	openPostgresSecretlessLease,
	openRedisSecretlessLease,
} from "../src/index.js";

describe("secretless mediation proof (ADR-0027)", () => {
	it("workload only receives local named endpoint; never credential material", () => {
		const credentialMaterial = "postgres-password-NEVER-IN-WORKLOAD";
		const connector = createSecretlessConnector({
			basePort: 25432,
			leaseTtlSeconds: 60,
		});

		const lease = openPostgresSecretlessLease(connector, {
			targetRef: "postgres://db.prod.internal:5432/orders",
			credentialMaterial,
			namedHost: "orders-db.camp.local.hobo.localhost",
		});

		// Workload surface: dial local named endpoint only.
		const workloadView = {
			endpoint: lease.localEndpoint,
			protocol: lease.protocol,
			targetRef: lease.targetRef,
			leaseId: lease.leaseId,
			expiresAt: lease.expiresAt,
		};

		expect(workloadView.endpoint).toBe(
			"orders-db.camp.local.hobo.localhost:25433",
		);
		expect(JSON.stringify(workloadView)).not.toContain(credentialMaterial);
		expect(JSON.stringify(lease)).not.toContain(credentialMaterial);

		const mediated = connector.mediate(lease.leaseId);
		expect(mediated.ok).toBe(true);
		expect(mediated.credentialExposedToWorkload).toBe(false);
		expect(JSON.stringify(mediated)).not.toContain(credentialMaterial);

		// Renewal keeps mediation invariant (partition-grace style).
		const renewed = connector.renewLease(lease.leaseId);
		expect(renewed?.leaseId).toBe(lease.leaseId);
		expect(JSON.stringify(renewed)).not.toContain(credentialMaterial);

		// Public list never enumerates credentials.
		for (const listed of connector.listLeases()) {
			expect(JSON.stringify(listed)).not.toContain(credentialMaterial);
		}

		connector.closeLease(lease.leaseId);
		expect(connector.mediate(lease.leaseId).ok).toBe(false);
	});

	it("generic TCP proxy mediation isolates credential", () => {
		const secret = "legacy-tcp-auth-token-xyz";
		const connector = createSecretlessConnector({ basePort: 19000 });
		const lease = connector.openLease({
			protocol: "tcp",
			targetRef: "tcp://legacy.internal:9000",
			credentialMaterial: secret,
			namedHost: "legacy.app.local.hobo.localhost",
		});
		const mediated = connector.mediate(lease.leaseId);
		expect(mediated.ok).toBe(true);
		expect(mediated.protocol).toBe("tcp");
		expect(mediated.credentialExposedToWorkload).toBe(false);
		expect(JSON.stringify({ lease, mediated })).not.toContain(secret);
	});

	it("mysql and redis plugins mediate with per-tenant isolation", () => {
		const secret = "tenant-db-password-zzz";
		const connector = createSecretlessConnector({
			isolation: "per-tenant",
			basePort: 14000,
		});
		const mysql = openMysqlSecretlessLease(connector, {
			targetRef: "mysql://db:3306/app",
			credentialMaterial: secret,
			tenantId: "t-acme",
			namedHost: "mysql.acme.local.hobo.localhost",
		});
		expect(mysql.isolation).toBe("per-tenant");
		expect(mysql.tenantId).toBe("t-acme");
		expect(connector.mediate(mysql.leaseId).ok).toBe(true);
		expect(JSON.stringify(mysql)).not.toContain(secret);

		const redis = openRedisSecretlessLease(connector, {
			targetRef: "redis://cache:6379/0",
			credentialMaterial: secret,
			tenantId: "t-acme",
		});
		expect(connector.mediate(redis.leaseId).protocol).toBe("redis");
		expect(connector.listLeases({ tenantId: "t-acme" })).toHaveLength(2);
		expect(connector.listPlugins().map((p) => p.id)).toEqual(
			expect.arrayContaining(["postgres", "tcp", "mysql", "redis"]),
		);
	});
});
