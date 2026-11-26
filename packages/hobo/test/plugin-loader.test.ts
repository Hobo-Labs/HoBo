import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RegistrableProvider } from "@hobo/cloud";
import { PluginManifestParseError, parsePluginPackageJson } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	loadHoboPlugin,
	PluginLoadError,
	registerPluginExtensions,
} from "../src/plugin-loader.js";

function fakeProvider(id: string): RegistrableProvider {
	return {
		id,
		regions: ["earth"],
		capabilities: [
			{
				port: "kv",
				satisfies: () => ({ kind: "full" }),
				estimateCost: () => ({ marginalPrice: "0", sku: "kv", unit: "op" }),
			},
		],
		capabilityManifest: () => ({
			providerId: id,
			published: {},
			capabilities: {},
			cost: {},
		}),
	};
}

const MANIFEST = {
	name: "@acme/hobo-provider-acme",
	hobo: {
		schema: "hobo.plugin/v1",
		entry: "./plugin.js",
		extensions: [
			{ point: "hobo.cloud-provider/v1", export: "createAcmeProvider" },
			{ point: "hobo.future-widget/v1", export: "createWidget" },
		],
	},
};

describe("registerPluginExtensions", () => {
	it("registers cloud providers through the installable seam and skips unknown points", () => {
		const registered = new Map<string, () => RegistrableProvider>();
		const report = registerPluginExtensions(
			parsePluginPackageJson(MANIFEST),
			{
				createAcmeProvider: () => fakeProvider("@acme/acme"),
				createWidget: () => ({}),
			},
			{ registerInstallable: (id, factory) => registered.set(id, factory) },
		);

		expect(report.packageName).toBe("@acme/hobo-provider-acme");
		expect(report.extensions).toEqual([
			{
				point: "hobo.cloud-provider/v1",
				export: "createAcmeProvider",
				id: "@acme/acme",
				status: "registered",
			},
			expect.objectContaining({
				point: "hobo.future-widget/v1",
				status: "skipped",
			}),
		]);
		expect(registered.has("@acme/acme")).toBe(true);
		expect(registered.get("@acme/acme")?.().id).toBe("@acme/acme");
	});

	it("prefers a manifest-declared registration id", () => {
		const registered = new Map<string, unknown>();
		const manifest = parsePluginPackageJson({
			...MANIFEST,
			hobo: {
				...MANIFEST.hobo,
				extensions: [
					{
						point: "hobo.cloud-provider/v1",
						export: "createAcmeProvider",
						id: "acme",
					},
				],
			},
		});
		registerPluginExtensions(
			manifest,
			{ createAcmeProvider: () => fakeProvider("@acme/acme") },
			{ registerInstallable: (id, factory) => registered.set(id, factory) },
		);
		expect([...registered.keys()]).toEqual(["acme"]);
	});

	it("fails closed on a missing export or a non-provider shape", () => {
		const manifest = parsePluginPackageJson({
			...MANIFEST,
			hobo: {
				...MANIFEST.hobo,
				extensions: [
					{ point: "hobo.cloud-provider/v1", export: "createAcmeProvider" },
				],
			},
		});
		expect(() =>
			registerPluginExtensions(manifest, {}, { registerInstallable: () => {} }),
		).toThrow(PluginLoadError);
		expect(() =>
			registerPluginExtensions(
				manifest,
				{ createAcmeProvider: () => ({ id: "" }) },
				{ registerInstallable: () => {} },
			),
		).toThrow(/did not produce a CloudProvider/);
	});
});

describe("loadHoboPlugin", () => {
	function writePluginPackage(overrides?: {
		hobo?: unknown;
		omitHobo?: boolean;
		entrySource?: string;
	}): string {
		const dir = mkdtempSync(path.join(tmpdir(), "hobo-plugin-"));
		mkdirSync(dir, { recursive: true });
		const hobo = overrides?.omitHobo
			? {}
			: {
					hobo: overrides?.hobo ?? {
						schema: "hobo.plugin/v1",
						entry: "./plugin.js",
						extensions: [
							{
								point: "hobo.cloud-provider/v1",
								export: "createAcmeProvider",
								id: "acme",
							},
						],
					},
				};
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				name: "@acme/hobo-provider-acme",
				type: "module",
				...hobo,
			}),
		);
		writeFileSync(
			path.join(dir, "plugin.js"),
			overrides?.entrySource ??
				`export function createAcmeProvider() {
					return {
						id: "@acme/acme",
						regions: ["earth"],
						capabilities: [{
							port: "kv",
							satisfies: () => ({ kind: "full" }),
							estimateCost: () => ({ marginalPrice: "0", sku: "kv", unit: "op" }),
						}],
						capabilityManifest: () => ({ providerId: "@acme/acme", published: {}, capabilities: {}, cost: {} }),
					};
				}
				`,
		);
		return dir;
	}

	it("loads a plugin package from an explicit path specifier", async () => {
		const dir = writePluginPackage();
		const registered = new Map<string, () => RegistrableProvider>();
		const report = await loadHoboPlugin(dir, {
			registerInstallable: (id, factory) => registered.set(id, factory),
		});
		expect(report.extensions[0]).toMatchObject({
			status: "registered",
			id: "acme",
		});
		expect(registered.get("acme")?.().id).toBe("@acme/acme");
	});

	it("rejects a package without a hobo key and a malformed manifest", async () => {
		const noKey = writePluginPackage({ omitHobo: true });
		await expect(loadHoboPlugin(noKey)).rejects.toThrow(
			PluginManifestParseError,
		);
		const badSchema = writePluginPackage({
			hobo: { schema: "hobo.plugin/v9", entry: "./plugin.js", extensions: [] },
		});
		await expect(loadHoboPlugin(badSchema)).rejects.toThrow(
			PluginManifestParseError,
		);
	});

	it("fails closed when the declared entry cannot be imported", async () => {
		const dir = writePluginPackage({
			entrySource: "export const nope = )broken(",
		});
		await expect(
			loadHoboPlugin(dir, { registerInstallable: () => {} }),
		).rejects.toThrow(PluginLoadError);
	});
});
