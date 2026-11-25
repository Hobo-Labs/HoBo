import { describe, expect, it } from "vitest";

import {
	config,
	env,
	evaluateSecretlessConfigGate,
	fromBinding,
	generateCtxConfigSource,
	schemaOnlyView,
	secret,
	sourceRankIndex,
} from "../src/index.js";

describe("secretless-first config schema (ADR-0027)", () => {
	it("builds typed schema with ranked sources", () => {
		const schema = config({
			LOG_LEVEL: env.string().default("info").enum(["debug", "info", "warn"]),
			FEATURE_X: env.boolean().default(false),
			MAX_CONCURRENCY: env.int().min(1).max(1000).default(32),
			DB_URL: secret.string().required().source("bound-resource"),
			API_KEY: secret.string().sensitive().source("provider-federation"),
			LEGACY_PASSWORD: secret
				.string()
				.sensitive()
				.source("static-escape")
				.ttl("7d")
				.rotation("required"),
		});
		expect(schema.kind).toBe("config-schema");
		expect(schema.schemaHash.startsWith("sha256:")).toBe(true);
		expect(schema.fields.DB_URL?.source).toBe("bound-resource");
		expect(schema.fields.LEGACY_PASSWORD?.ttl).toBe("7d");
		expect(schema.fields.LOG_LEVEL?.sensitive).toBe(false);
	});

	it("rejects static-escape TTL > 7d", () => {
		expect(() =>
			config({
				X: secret.string().source("static-escape").ttl("30d"),
			}),
		).toThrow(/7d/);
	});

	it("rejects sensitive defaults", () => {
		expect(() =>
			config({
				X: secret.string().default("super-secret"),
			}),
		).toThrow(/cannot have default values/);
	});

	it("schemaOnlyView never includes defaults for secrets", () => {
		const schema = config({
			LOG_LEVEL: env.string().default("info"),
			DB_URL: secret.string().required(),
		});
		const view = schemaOnlyView(schema);
		expect(view.fields.DB_URL?.sensitive).toBe(true);
		expect(JSON.stringify(view)).not.toMatch(/super-secret|password/i);
	});

	it("fromBinding marks bound-resource sensitive", () => {
		const field = fromBinding("db");
		expect(field.source).toBe("bound-resource");
		expect(field.sensitive).toBe(true);
	});

	it("source ranking order", () => {
		expect(sourceRankIndex("bound-resource")).toBeLessThan(
			sourceRankIndex("static-escape"),
		);
	});

	it("env() annotation still works for resource injection", () => {
		const ann = env({ GREETING: "hi" });
		expect(ann.option).toBe("env");
		expect(ann.config.GREETING).toBe("hi");
	});

	it("generates typed ctx.config source without secret values", () => {
		const schema = config({
			LOG_LEVEL: env.string().default("info").enum(["debug", "info"]),
			DB_URL: secret.string().required().source("bound-resource"),
		});
		const src = generateCtxConfigSource(schema);
		expect(src).toContain("export interface CtxConfig");
		expect(src).toContain("LOG_LEVEL");
		expect(src).toContain("DB_URL");
		expect(src).toMatch(/REDACTED/);
		expect(src).not.toMatch(/password|super-secret/i);
	});

	it("can-deploy dimension forbids static-escape in production", () => {
		const schema = config({
			LEGACY: secret
				.string()
				.source("static-escape")
				.ttl("7d")
				.rotation("required"),
		});
		const gate = evaluateSecretlessConfigGate({
			schema,
			environment: "production",
		});
		expect(gate.ok).toBe(false);
		expect(gate.reasons.some((r) => r.code === "static-escape-forbidden")).toBe(
			true,
		);
		const dev = evaluateSecretlessConfigGate({
			schema,
			environment: "dev",
			forbidStaticEscape: false,
		});
		expect(dev.ok).toBe(true);
	});
});
