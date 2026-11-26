import {
	asHoboSecretsStore,
	requireNoPlaintextConformance,
	resolveConfigEntry,
} from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	createLocalStationOpenBaoSecretsPort,
	createOpenBaoSecretsPort,
} from "../src/index.js";

describe("@hobo/adapter-openbao residual SecretsPort", () => {
	it("offline adapter is deterministic and JWT-only", async () => {
		const a = createOpenBaoSecretsPort({
			openbaoAddr: "https://openbao.example:8200",
			role: "hobo-workload",
			svidJwt: "eyJhbGciOiJFUzI1NiJ9.svid.fixture",
			offline: true,
		});
		const b = createOpenBaoSecretsPort({
			openbaoAddr: "https://openbao.example:8200",
			role: "hobo-workload",
			svidJwt: "eyJhbGciOiJFUzI1NiJ9.svid.fixture",
			offline: true,
		});
		expect(a.kind).toBe("openbao");
		const r1 = await a.access("app/db");
		const r2 = await b.access("app/db");
		expect(r1.status).toBe("ok");
		expect(r2.status).toBe("ok");
		if (r1.status === "ok" && r2.status === "ok") {
			expect(r1.material).toBe(r2.material);
			expect(r1.valueRef).toMatch(/^openbao:\/\//);
			expect(r1.valueRef).not.toContain(r1.material ?? "___");
			expect(r1.expiresAt).toBeTruthy();
		}
		await a.put("app/db", "seed-v1");
		const versions = await a.listVersions("app/db");
		expect(versions.length).toBeGreaterThan(0);
	});

	it("live path uses JWT login + KV v2 via injected fetch", async () => {
		const calls: string[] = [];
		const fetch = async (
			url: string,
			init?: {
				method?: string;
				headers?: Record<string, string>;
				body?: string;
			},
		) => {
			calls.push(url);
			if (url.includes("/auth/jwt/login")) {
				// SAFETY: assertion to `JSON.parse(init?.body ?? "{}") as { jwt?: string; }` is required at this boundary.
				const body = JSON.parse(init?.body ?? "{}") as {
					jwt?: string;
				};
				expect(body.jwt).toMatch(/^eyJ/);
				expect(body.jwt).not.toMatch(/^hvs\./);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						auth: { client_token: "s.short-lived", lease_duration: 600 },
					}),
					text: async () => "",
				};
			}
			if (url.includes("/data/app/key")) {
				expect(init?.headers?.["X-Vault-Token"]).toBe("s.short-lived");
				expect(init?.headers?.["X-Vault-Namespace"]).toBe("team-a");
				return {
					ok: true,
					status: 200,
					json: async () => ({
						data: {
							data: { value: "live-openbao-material" },
							metadata: { version: 3 },
						},
						lease_duration: 300,
					}),
					text: async () => "",
				};
			}
			return {
				ok: false,
				status: 404,
				json: async () => ({}),
				text: async () => "not found",
			};
		};
		const port = createOpenBaoSecretsPort({
			openbaoAddr: "https://openbao.example:8200",
			role: "hobo-workload",
			svidJwt: "eyJhbGciOiJFUzI1NiJ9.svid.fixture",
			namespace: "team-a",
			fetch,
			offline: false,
		});
		const accessed = await port.access("app/key");
		expect(accessed.status).toBe("ok");
		if (accessed.status === "ok") {
			expect(accessed.material).toBe("live-openbao-material");
			expect(accessed.versionId).toBe("obv3");
		}
		expect(calls.some((u) => u.includes("/auth/jwt/login"))).toBe(true);
	});

	it("local station helper defaults offline OpenBao", async () => {
		const port = createLocalStationOpenBaoSecretsPort({
			stationId: "wasm-dev",
			offline: true,
		});
		expect(port.kind).toBe("openbao");
		await port.put("DB_PASSWORD", "broker-only");
		const r = await port.access("DB_PASSWORD");
		expect(r.status).toBe("ok");
		if (r.status === "ok") {
			expect(r.valueRef).toMatch(/^openbao:\/\//);
		}
	});

	it("ladder + WIT residual keep agent-facing surfaces redacted", async () => {
		const port = createOpenBaoSecretsPort({
			openbaoAddr: "https://openbao.camp.local",
			role: "workload",
			svidJwt: "eyJhbGciOiJFUzI1NiJ9.svid.fixture",
			offline: true,
		});
		await port.put("API_KEY", "broker-only-secret");
		const result = await resolveConfigEntry({
			name: "API_KEY",
			sensitive: true,
			preferredSource: "provider-federation",
			allowedSources: ["provider-federation"],
			secretsPort: port,
		});
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") {
			expect(result.entry.placeholder).toMatch(/REDACTED/);
			expect(JSON.stringify(result.entry)).not.toContain("broker-only-secret");
		}
		const store = asHoboSecretsStore(port);
		const latest = await store.access("API_KEY");
		expect(latest.versionId).toBeTruthy();
		requireNoPlaintextConformance({
			agentContext: { API_KEY: "[REDACTED:provider-federation:API_KEY]" },
			events: [
				{
					type: "secret.Accessed",
					data: {
						name: "API_KEY",
						valueRef: "openbao://x/secret/API_KEY@obv1",
						redacted: true,
					},
				},
			],
			logs: "adapter-openbao residual",
		});
	});
});
