import { expect, it } from "vitest";
import { createContractAssertedConfigFixtures } from "../src/config-dev-fixtures.js";
import { resolveConfigSchema } from "../src/config-resolver.js";
import type { ConfigFieldDef, ConfigSchema } from "../src/config-types.js";
import { createMemorySecretsPort } from "../src/secrets-port.js";

const field: ConfigFieldDef = {
	kind: "config-field",
	type: "string",
	required: true,
	sensitive: false,
	source: "camp-value",
};

function schema(
	fields: Readonly<Record<string, ConfigFieldDef>>,
): ConfigSchema {
	return {
		kind: "config-schema",
		schemaVersion: "hobo.config-schema/v1",
		schemaHash: "sha256:test",
		fields,
	};
}

it("keeps internal values out of agent views and event payloads", async () => {
	const result = await resolveConfigSchema({
		tenant: "tenant-a",
		schema: schema({ internal: { ...field, sensitivity: "internal" } }),
		campValues: { internal: "private-value" },
	});
	expect(result.entries.internal?.sensitivity).toBe("internal");
	expect(result.entries.internal?.value).toBe("private-value");
	expect(result.agentView.fields.internal?.sensitivity).toBe("internal");
	expect(result.events[0]?.data.sensitivity).toBe("internal");
	expect(JSON.stringify(result.agentView)).not.toContain("private-value");
	expect(JSON.stringify(result.events)).not.toContain("private-value");
});

it("treats explicit and conflicting sensitivity as secret and audits access", async () => {
	const result = await resolveConfigSchema({
		tenant: "tenant-a",
		schema: schema({
			explicit: {
				...field,
				source: "bound-resource",
				sensitivity: "sensitive",
			},
			conflict: {
				...field,
				source: "bound-resource",
				sensitive: true,
				sensitivity: "public",
			},
		}),
		boundTokens: {
			explicit: async () => "explicit-secret",
			conflict: async () => "conflicting-secret",
		},
	});
	expect(result.entries.explicit?.sensitivity).toBe("sensitive");
	expect(result.entries.explicit?.value).toBeUndefined();
	expect(result.entries.conflict?.sensitivity).toBe("sensitive");
	expect(result.entries.conflict?.value).toBeUndefined();
	expect(result.agentView.fields.explicit?.sensitivity).toBe("sensitive");
	expect(result.agentView.fields.conflict?.sensitivity).toBe("sensitive");
	expect(
		result.events.filter((event) => event.type === "secret.Accessed"),
	).toHaveLength(2);
	expect(JSON.stringify(result)).not.toMatch(
		/explicit-secret|conflicting-secret/,
	);
});

it("resolves prototype-named fields only from own entries", async () => {
	const definitions = Object.fromEntries([
		["__proto__", { ...field }],
		["constructor", { ...field }],
	]);
	const configSchema = schema(definitions);
	const values = JSON.parse('{"__proto__":"first","constructor":"second"}');
	const result = await resolveConfigSchema({
		tenant: "tenant-a",
		schema: configSchema,
		campValues: values,
	});
	expect(Object.hasOwn(result.entries, "__proto__")).toBe(true);
	expect(Object.hasOwn(result.agentView.fields, "__proto__")).toBe(true);
	const prototypeField = Object.entries(result.agentView.fields).find(
		([name]) => name === "__proto__",
	)?.[1];
	expect(prototypeField?.sensitivity).toBe("public");
	expect(result.agentView.fields.constructor.sensitivity).toBe("public");
	expect(JSON.stringify(result.agentView)).not.toMatch(/first|second/);
	const missing = schema({
		constructor: { ...field, source: "bound-resource" },
	});
	await expect(
		resolveConfigSchema({
			tenant: "tenant-a",
			schema: missing,
			boundTokens: {},
		}),
	).rejects.toThrow("required config");
});

it("keeps sensitive defaults out of development fixtures", async () => {
	const configSchema = schema({
		secret: {
			...field,
			source: "bound-resource",
			sensitivity: "sensitive",
			defaultValue: "private-default",
		},
	});
	const fixtures = await createContractAssertedConfigFixtures(configSchema, {
		campValues: { secret: "private-override" },
	});
	expect(Object.hasOwn(fixtures.campValues, "secret")).toBe(false);
	expect(fixtures.boundTokens.secret).toBeTypeOf("function");
});

it("keeps internal bound tokens out of agent views while retaining the runtime value", async () => {
	const result = await resolveConfigSchema({
		tenant: "tenant-a",
		schema: schema({
			internal: {
				...field,
				source: "bound-resource",
				sensitivity: "internal",
			},
		}),
		boundTokens: { internal: async () => "runtime-token" },
	});
	expect(result.entries.internal?.value).toBe("runtime-token");
	expect(result.entries.internal?.sensitivity).toBe("internal");
	expect(result.agentView.fields.internal?.sensitivity).toBe("internal");
	expect(JSON.stringify(result.agentView)).not.toContain("runtime-token");
	expect(JSON.stringify(result.events)).not.toContain("runtime-token");
});

it("audits a sensitive provider fallback for a public field", async () => {
	const secrets = createMemorySecretsPort();
	await secrets.put("token", "private-material");
	const result = await resolveConfigSchema({
		tenant: "tenant-a",
		schema: schema({
			token: { ...field, source: "provider-federation" },
		}),
		secretsPort: secrets,
	});
	expect(result.entries.token?.sensitivity).toBe("sensitive");
	expect(
		result.events.filter((event) => event.type === "secret.Accessed"),
	).toHaveLength(1);
	expect(JSON.stringify(result)).not.toContain("private-material");
});

it("rejects camp values for fields classified as sensitive", async () => {
	await expect(
		resolveConfigSchema({
			tenant: "tenant-a",
			schema: schema({ secret: { ...field, sensitivity: "sensitive" } }),
			campValues: { secret: "private-material" },
		}),
	).rejects.toThrow("required config");
});

it("keeps prototype-named defaults and token factories as own fixture entries", async () => {
	const configSchema = schema(
		Object.fromEntries([
			["__proto__", { ...field, defaultValue: "own-default" }],
			[
				"constructor",
				{ ...field, source: "bound-resource", sensitivity: "sensitive" },
			],
		]),
	);
	const fixtures = await createContractAssertedConfigFixtures(configSchema);
	expect(
		Object.getOwnPropertyDescriptor(fixtures.campValues, "__proto__")?.value,
	).toBe("own-default");
	expect(Object.hasOwn(fixtures.boundTokens, "constructor")).toBe(true);
	expect(await fixtures.boundTokens.constructor()).toMatch(/^dev-bound-token:/);
});
