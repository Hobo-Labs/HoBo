import { describe, expect, it } from "vitest";

import {
	discoveryEnvForDependency,
	evaluateBindingDeliveryGate,
	isForbiddenSecretEnvKey,
	looksLikeSecretEnvValue,
} from "../src/index.js";
import { compileBindleManifest, data, service } from "../src/wiring/index.js";

describe("binding-delivery membrane (ADR-0141)", () => {
	it("forbids ConnectionStrings and secret-shaped env keys", () => {
		expect(isForbiddenSecretEnvKey("ConnectionStrings__db")).toBe(true);
		expect(isForbiddenSecretEnvKey("DATABASE_URL")).toBe(true);
		expect(isForbiddenSecretEnvKey("LOG_LEVEL")).toBe(false);
		expect(looksLikeSecretEnvValue("postgres://u:p@host/db")).toBe(true);
		expect(looksLikeSecretEnvValue("{db.connectionString}")).toBe(true);
		expect(looksLikeSecretEnvValue("https://api.example")).toBe(false);
	});

	it("discoveryEnv never emits connection strings", () => {
		const env = discoveryEnvForDependency(
			"db",
			{ connectionString: "postgres://u:secret@host/db" },
			{
				connectionString: "postgres://u:secret@host/db",
				httpUrl: "http://db.internal:5432",
			},
		);
		expect(env.ConnectionStrings__db).toBeUndefined();
		expect(JSON.stringify(env)).not.toContain("secret");
		expect(env.services__db__http__0).toBe("http://db.internal:5432");
	});

	it("gate fails closed on ConnectionStrings in resource env", () => {
		const bad = evaluateBindingDeliveryGate({
			resourceEnvs: {
				api: {
					ConnectionStrings__db: "{db.connectionString}",
				},
			},
		});
		expect(bad.ok).toBe(false);
		expect(bad.reasons.some((r) => r.code === "connection-strings-env")).toBe(
			true,
		);

		const good = evaluateBindingDeliveryGate({
			resourceEnvs: {
				api: { LOG_LEVEL: "info" },
			},
		});
		expect(good.ok).toBe(true);
	});

	it("compiled bind IR has links and passes binding-delivery gate", () => {
		const db = data("db", { paradigm: "relational" });
		const api = service("api", {
			image: "oci://registry.example.com/api@sha256:abc",
			bind: { db },
			env: { LOG_LEVEL: "info" },
		});
		const manifest = compileBindleManifest([db, api]);
		// SAFETY: assertion required at this I/O or test boundary.
		const env = (manifest.resources.api?.env ?? {}) as Record<string, string>;
		const gate = evaluateBindingDeliveryGate({
			resourceEnvs: { api: env },
		});
		expect(gate.ok).toBe(true);
		expect(manifest.resources.api?.links?.length).toBeGreaterThan(0);
	});
});
