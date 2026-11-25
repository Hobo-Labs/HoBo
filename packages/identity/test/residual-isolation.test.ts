import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	assertNoPlaintextConformance,
	createLocalStationSecretsPort,
	createMemorySecretsPort,
	resolveConfigSchema,
} from "../src/index.js";

/**
 * Residual secrets discipline (ADR-0142): memory default; OpenBao not a
 * default identity dependency; agent surfaces stay free of residual material.
 */
describe("residual secrets isolation", () => {
	it("identity package does not depend on adapter-openbao", () => {
		// SAFETY: assertion to `JSON.parse( readFileSync(new URL("../package.json", import.meta.url), "utf8"), ) as { dependencies?: Record<string, stri` is required at this boundary.
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(pkg.dependencies?.["@hobo/adapter-openbao"]).toBeUndefined();
		expect(JSON.stringify(pkg.dependencies ?? {})).not.toMatch(/openbao/i);
	});

	it("local station residual defaults to memory", () => {
		const port = createLocalStationSecretsPort({ stationId: "iso" });
		expect(port.kind).toBe("memory-fixture");
	});

	it("openbao backend fails closed with install hint", () => {
		expect(() =>
			createLocalStationSecretsPort({
				env: { HOBO_LOCAL_SECRETS_BACKEND: "openbao" },
			}),
		).toThrow(/@hobo\/adapter-openbao/);
	});

	it("agent/events never receive residual material", async () => {
		const port = createMemorySecretsPort();
		await port.put("LEGACY", "residual-material-should-not-leak");
		const schema = {
			kind: "config-schema" as const,
			schemaVersion: "hobo.config-schema/v1" as const,
			schemaHash: "sha256:iso" as const,
			fields: {
				LEGACY: {
					kind: "config-field" as const,
					name: "LEGACY",
					type: "string" as const,
					required: true,
					sensitive: true,
					source: "provider-federation" as const,
				},
			},
		};
		const resolved = await resolveConfigSchema({
			tenant: "iso",
			schema,
			secretsPort: port,
			forbidStaticEscape: true,
		});
		expect(resolved.agentView.LEGACY).toMatch(/REDACTED/);
		const blob = JSON.stringify({
			agentView: resolved.agentView,
			events: resolved.events,
			entries: resolved.entries,
		});
		expect(blob).not.toContain("residual-material-should-not-leak");
		const conf = assertNoPlaintextConformance({
			agentContext: resolved.agentView,
			events: resolved.events,
		});
		expect(conf.ok).toBe(true);
	});
});
