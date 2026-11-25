import { describe, expect, it } from "vitest";

import {
	createSecretlessConnector,
	openPostgresSecretlessLease,
} from "../src/index.js";

describe("secretless connector mediation", () => {
	it("opens postgres lease without exposing credential on lease object", () => {
		const connector = createSecretlessConnector({ basePort: 20000 });
		const lease = openPostgresSecretlessLease(connector, {
			targetRef: "postgres://db.internal:5432/app",
			credentialMaterial: "super-secret-db-password",
			namedHost: "db.app.local.hobo.localhost",
		});
		expect(lease.protocol).toBe("postgres");
		expect(lease.localEndpoint).toContain("db.app.local.hobo.localhost");
		expect(lease.hasCredential).toBe(true);
		// Credential never enumerable on public lease.
		expect(JSON.stringify(lease)).not.toContain("super-secret-db-password");
		expect(Object.keys(lease).every((k) => k !== "credentialMaterial")).toBe(
			true,
		);

		const mediated = connector.mediate(lease.leaseId);
		expect(mediated.ok).toBe(true);
		expect(mediated.credentialExposedToWorkload).toBe(false);
		expect(JSON.stringify(mediated)).not.toContain("super-secret-db-password");
	});

	it("renews and closes leases", () => {
		const connector = createSecretlessConnector();
		const lease = connector.openLease({
			protocol: "tcp",
			targetRef: "tcp://legacy:9000",
			credentialMaterial: "legacy-token",
		});
		const renewed = connector.renewLease(lease.leaseId);
		expect(renewed?.leaseId).toBe(lease.leaseId);
		expect(connector.closeLease(lease.leaseId)).toBe(true);
		expect(connector.getLease(lease.leaseId)).toBeUndefined();
	});
});
