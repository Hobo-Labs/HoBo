import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ciEnvironmentPolicySha256,
	parseCiProjectConfig,
	selectCiEnvironment,
} from "../src/project-config.js";

const fixture = JSON.parse(
	readFileSync(
		new URL(
			"../../ci/data-models/fixtures/valid/desired-policy.json",
			import.meta.url,
		),
		"utf8",
	),
);

function config() {
	return {
		defaultEnvironment: "integration",
		templates: {
			standard: {
				secrets: { WEBHOOK_SECRET: { requiredFor: ["execution"] } },
				policy: {
					pool: fixture.pool,
					budget: { ...fixture.budget, limitMicros: 1 },
					routing: fixture.routing,
					thresholds: [],
				},
			},
		},
		environments: {
			integration: {
				extends: "standard",
				relayOrigin: "https://ci.example.test",
				policy: {
					accountId: "integration",
					tenantId: "integration",
					providers: fixture.providers,
					budget: { limitMicros: 5000 },
				},
			},
		},
	};
}

describe("CI environment template references", () => {
	it("resolves common fields and nested overrides into an independently validated profile", async () => {
		const source = config();
		const result = parseCiProjectConfig(JSON.stringify(source));
		const selected = selectCiEnvironment(result, "integration");
		expect(selected.policy.budget?.limitMicros).toBe(5000);
		expect(selected.policy.pool).toMatchObject(fixture.pool);
		expect(selected.secrets.WEBHOOK_SECRET?.requiredFor).toEqual(["execution"]);
		const expanded = {
			defaultEnvironment: "integration",
			environments: {
				integration: {
					relayOrigin: "https://ci.example.test",
					secrets: source.templates.standard.secrets,
					policy: {
						...fixture,
						accountId: "integration",
						tenantId: "integration",
						budget: { ...fixture.budget, limitMicros: 5000 },
						thresholds: [],
					},
				},
			},
		};
		expect(await ciEnvironmentPolicySha256(result, "integration")).toBe(
			await ciEnvironmentPolicySha256(
				parseCiProjectConfig(JSON.stringify(expanded)),
				"integration",
			),
		);
	});

	it("rejects missing references and template chaining", () => {
		const missing = config();
		missing.environments.integration.extends = "missing";
		expect(() => parseCiProjectConfig(JSON.stringify(missing))).toThrow(
			"invalid CI project configuration",
		);
		const chain = config();
		Object.assign(chain.templates.standard, { extends: "standard" });
		expect(() => parseCiProjectConfig(JSON.stringify(chain))).toThrow(
			"invalid CI project configuration",
		);
	});

	it("replaces arrays and merges environment-specific secret declarations", () => {
		const source = config();
		Object.assign(source.templates.standard.policy, {
			providers: fixture.providers,
		});
		Object.assign(source.environments.integration, {
			secrets: {
				WEBHOOK_SECRET: { requiredFor: ["deployment"] },
				ACCOUNT_TOKEN: { requiredFor: ["execution"] },
			},
		});
		Object.assign(source.environments.integration.policy, {
			providers: [{ ...fixture.providers[0], id: "replacement" }],
		});
		const selected = selectCiEnvironment(
			parseCiProjectConfig(JSON.stringify(source)),
		);
		expect(selected.policy.providers.map((provider) => provider.id)).toEqual([
			"replacement",
		]);
		expect(selected.secrets.WEBHOOK_SECRET?.requiredFor).toEqual([
			"deployment",
		]);
		expect(selected.secrets.ACCOUNT_TOKEN?.requiredFor).toEqual(["execution"]);
	});

	it("rejects hidden inline secrets and unknown policy properties even from templates", () => {
		const secret = config();
		Object.assign(secret.templates.standard.secrets.WEBHOOK_SECRET, {
			value: "not-for-errors",
		});
		try {
			parseCiProjectConfig(JSON.stringify(secret));
			throw new Error("expected rejection");
		} catch (error) {
			expect(String(error)).not.toContain("not-for-errors");
			expect(String(error)).toContain("invalid CI project configuration");
		}
		const policy = config();
		Object.assign(policy.templates.standard.policy, { typo: true });
		expect(() => parseCiProjectConfig(JSON.stringify(policy))).toThrow();
	});
});
