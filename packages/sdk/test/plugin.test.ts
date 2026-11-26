import { describe, expect, it } from "vitest";

import {
	assertPluginExports,
	definePlugin,
	PLUGIN_DECLARATION_SCHEMA,
	SdkDeclarationError,
} from "../src/index.js";

const SPEC = {
	package: "@acme/hobo-provider-acme",
	entry: "./dist/plugin.js",
	extensions: [
		{
			point: "hobo.cloud-provider/v1",
			export: "createAcmeProvider",
			id: "acme",
		},
	],
};

describe("definePlugin", () => {
	it("produces a frozen declaration wrapping the core manifest", () => {
		const declaration = definePlugin(SPEC);
		expect(declaration.schema).toBe(PLUGIN_DECLARATION_SCHEMA);
		expect(declaration.packageName).toBe("@acme/hobo-provider-acme");
		expect(declaration.manifest.schema).toBe("hobo.plugin/v1");
		expect(declaration.packageJsonFragment.hobo).toBe(declaration.manifest);
		expect(Object.isFrozen(declaration)).toBe(true);
		expect(Object.isFrozen(declaration.manifest.extensions)).toBe(true);
	});

	it("rejects what the core parser rejects, as an SdkDeclarationError", () => {
		expect(() => definePlugin({ ...SPEC, entry: "dist/plugin.js" })).toThrow(
			SdkDeclarationError,
		);
		expect(() =>
			definePlugin({
				...SPEC,
				extensions: [{ point: "not-a-point/v1", export: "x" }],
			}),
		).toThrow(SdkDeclarationError);
		expect(() => definePlugin({ ...SPEC, package: "" })).toThrow(
			SdkDeclarationError,
		);
	});
});

describe("assertPluginExports", () => {
	it("passes when every declared export is a function, fails otherwise", () => {
		const declaration = definePlugin(SPEC);
		expect(() =>
			assertPluginExports(declaration, { createAcmeProvider: () => ({}) }),
		).not.toThrow();
		expect(() => assertPluginExports(declaration, {})).toThrow(
			/does not export function "createAcmeProvider"/,
		);
	});
});
