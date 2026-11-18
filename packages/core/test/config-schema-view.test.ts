import { describe, expect, it } from "vitest";
import { createAgentConfigSchemaView } from "../src/config-schema-view.js";

describe("agent config schema view", () => {
	it("exposes immutable metadata without values or author text", () => {
		const schema = JSON.parse(`{
			"schemaVersion":"hobo.config-schema/v1",
			"schemaHash":"sha256:test",
			"fields":{
				"LOG_LEVEL":{"type":"string","required":false,"sensitive":false,"source":"camp-value","defaultValue":"debug","docs":"private-value"},
				"API_KEY":{"type":"string","required":true,"sensitive":true,"sensitivity":"public","source":"provider-federation"}
			}
		}`);
		const view = createAgentConfigSchemaView(schema);

		expect(view.fields.LOG_LEVEL).toEqual({
			type: "string",
			required: false,
			sensitive: false,
			sensitivity: "public",
			source: "camp-value",
		});
		expect(view.fields.API_KEY?.sensitivity).toBe("sensitive");
		expect(JSON.stringify(view)).not.toMatch(/debug|private-value/);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.fields)).toBe(true);
		expect(Object.isFrozen(view.fields.LOG_LEVEL)).toBe(true);
		expect(Reflect.set(view.fields.LOG_LEVEL ?? {}, "required", true)).toBe(
			false,
		);
	});

	it("preserves prototype-named fields without prototype mutation", () => {
		const schema = JSON.parse(`{
			"schemaVersion":"hobo.config-schema/v1",
			"schemaHash":"sha256:test",
			"fields":{
				"__proto__":{"type":"string","required":false,"sensitive":false,"source":"camp-value"},
				"constructor":{"type":"boolean","required":true,"sensitive":false,"sensitivity":"internal","source":"bound-resource"}
			}
		}`);
		const view = createAgentConfigSchemaView(schema);

		expect(Object.hasOwn(view.fields, "__proto__")).toBe(true);
		expect(Object.hasOwn(view.fields, "constructor")).toBe(true);
		expect(Object.getPrototypeOf(view.fields)).toBe(Object.prototype);
		expect(view.fields.constructor.sensitivity).toBe("internal");
	});

	it("classifies missing and invalid sensitivity as sensitive", () => {
		const view = createAgentConfigSchemaView({
			schemaVersion: "hobo.config-schema/v1",
			schemaHash: "sha256:test",
			fields: {
				missing: {
					type: "string",
					required: false,
					source: "camp-value",
				},
				invalid: {
					type: "string",
					required: false,
					sensitive: false,
					sensitivity: "restricted",
					source: "camp-value",
				},
			},
		});

		expect(view.fields.missing?.sensitivity).toBe("sensitive");
		expect(view.fields.invalid?.sensitivity).toBe("sensitive");
	});

	it("rejects malformed field metadata", () => {
		expect(() =>
			createAgentConfigSchemaView({
				schemaVersion: "hobo.config-schema/v1",
				schemaHash: "sha256:test",
				fields: {
					bad: {
						type: "password",
						required: false,
						sensitive: false,
						source: "camp-value",
					},
				},
			}),
		).toThrow("config field type is invalid");
	});
});
