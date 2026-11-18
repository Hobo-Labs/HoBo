import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import {
	config,
	env,
	evaluateSecretlessConfigGate,
	generateCtxConfigSource,
	materializeAgentConfigView,
	schemaOnlyView,
	sensitivityForField,
} from "../src/index.js";

it("preserves prototype-named fields through schema, hash, and agent views", () => {
	const definitions = Object.fromEntries([
		["__proto__", env.string()],
		["constructor", env.string()],
		["odd-name", env.string()],
	]);
	const schema = config(definitions);
	const empty = config({});
	expect(Object.keys(schema.fields).sort()).toEqual([
		"__proto__",
		"constructor",
		"odd-name",
	]);
	expect(schema.schemaHash).not.toBe(empty.schemaHash);
	const schemaView = schemaOnlyView(schema);
	expect(Object.hasOwn(schemaView.fields, "__proto__")).toBe(true);
	expect(Object.getPrototypeOf(schemaView.fields)).toBe(Object.prototype);
	const values = JSON.parse(
		'{"__proto__":"first","constructor":"second","odd-name":"third"}',
	);
	const view = materializeAgentConfigView(schema, values);
	expect(Object.hasOwn(view, "__proto__")).toBe(true);
	expect(Object.getOwnPropertyDescriptor(view, "__proto__")?.value).toBe(
		"first",
	);
	expect(view.constructor).toBe("second");
	expect(view["odd-name"]).toBe("third");
	expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
});

it("never exposes internal or sensitive values to an agent", () => {
	const field = {
		kind: "config-field",
		type: "string",
		required: false,
		sensitive: false,
		source: "bound-resource",
	} as const;
	const schema = config({
		internal: { ...field, sensitivity: "internal" },
		secret: { ...field, sensitivity: "sensitive" },
		conflict: { ...field, sensitive: true, sensitivity: "public" },
		public: { ...field, sensitivity: "public" },
	});
	const view = materializeAgentConfigView(schema, {
		internal: "private-value",
		secret: "sensitive-value",
		conflict: "conflicting-value",
		public: "public-value",
	});
	expect(view.internal).toMatch(/^\[REDACTED:/);
	expect(view.secret).toMatch(/^\[REDACTED:/);
	expect(view.conflict).toMatch(/^\[REDACTED:/);
	expect(view.public).toBe("public-value");
	expect(JSON.stringify(view)).not.toMatch(
		/private-value|sensitive-value|conflicting-value/,
	);
	expect(sensitivityForField({ sensitive: true, sensitivity: "public" })).toBe(
		"sensitive",
	);
	const malformed = JSON.parse(
		'{"sensitive":false,"sensitivity":"restricted"}',
	);
	expect(sensitivityForField(malformed)).toBe("sensitive");
});

it("rejects sensitive defaults even when the legacy flag is false", () => {
	const field = {
		kind: "config-field",
		type: "string",
		required: false,
		sensitive: false,
		sensitivity: "sensitive",
		source: "bound-resource",
		defaultValue: "secret-value",
	} as const;
	expect(() => config({ secret: field })).toThrow(/cannot have default values/);
	const gate = evaluateSecretlessConfigGate({
		schema: {
			kind: "config-schema",
			schemaVersion: "hobo.config-schema/v1",
			schemaHash: "sha256:test",
			fields: { secret: field },
		},
	});
	expect(gate.ok).toBe(false);
	expect(
		gate.reasons.some((reason) => reason.code === "sensitive-default"),
	).toBe(true);
});

it("generates valid, comment-free TypeScript for arbitrary field names", () => {
	const schema = config(
		Object.fromEntries([
			["odd-name", env.string()],
			["__proto__", env.string()],
		]),
	);
	const source = generateCtxConfigSource(schema);
	expect(source).not.toMatch(/\/[/*]/);
	expect(source).toContain('readonly "odd-name"');
	expect(source).toContain('readonly "__proto__"');
	const result = spawnSync(
		process.execPath,
		["--input-type=module-typescript"],
		{
			input: source,
			encoding: "utf8",
			timeout: 10_000,
		},
	);
	expect(result.status, result.stderr).toBe(0);
	expect(() =>
		generateCtxConfigSource(schema, { interfaceName: "bad name" }),
	).toThrow();
	expect(() =>
		generateCtxConfigSource(schema, { interfaceName: "class" }),
	).toThrow();
});
