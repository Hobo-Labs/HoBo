import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CONFIG_SERVICE_MAIN_MODULE,
	ConfigServiceBindingError,
	configServiceWorkerModules,
	formatOwnerAccess,
	formatWorkerBinding,
	parseConfigServiceOrigin,
} from "../src/index.js";

const DIST = new URL("../dist/worker/", import.meta.url);

describe("the Worker's upload", () => {
	it("is the compiled modules, importing only each other, with no source maps", async () => {
		const modules = await configServiceWorkerModules(DIST);
		expect(modules.map((module) => module.name)).toContain(
			CONFIG_SERVICE_MAIN_MODULE,
		);
		for (const module of modules) {
			expect(module.source).not.toMatch(/sourceMappingURL/u);
			expect(module.source).not.toMatch(/from "(?!\.\/)/u);
		}
		const main = modules.find(
			(module) => module.name === CONFIG_SERVICE_MAIN_MODULE,
		);
		// workerd accepts only handlers and classes from the main module.
		expect(
			[
				...(main?.source.matchAll(/^export (?:\{ (\w+) \}|default)/gmu) ?? []),
			].map((m) => m[1] ?? "default"),
		).toEqual(["ConfigStore", "default"]);
	});

	it("refuses a build whose modules reach outside themselves", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "hobo-config-worker-"));
		await writeFile(
			path.join(directory, "index.js"),
			'import x from "node:fs";\nexport default {};\n',
		);
		await expect(
			configServiceWorkerModules(pathToFileURL(`${directory}/`)),
		).rejects.toThrow(/not one of its sibling modules/u);
	});
});

describe("the deploy-time binding and the client's origin", () => {
	it("refuses a binding the Worker would not accept", () => {
		expect(() =>
			formatWorkerBinding({
				storeId: "hobo0fixture0store1",
				vercelTeamSlug: "Not A Slug",
				vercelTeamId: "team_fixture",
				vercelProjectName: "hobo-ci",
				vercelProjectId: "prj_fixture",
				repository: "Hobo-Labs/HoBo",
				bootstrapSha256: "0".repeat(64),
				bootstrapExpiresAt: new Date(),
			}),
		).toThrow(ConfigServiceBindingError);
		expect(() =>
			formatOwnerAccess("https://evil.example.com", "a".repeat(32)),
		).toThrow(ConfigServiceBindingError);
	});

	it("takes an HTTPS origin only, with no userinfo or path", () => {
		expect(parseConfigServiceOrigin("https://a.b.workers.dev/")).toBe(
			"https://a.b.workers.dev",
		);
		for (const bad of [
			"http://a.workers.dev",
			"https://user@a.workers.dev",
			"https://a.workers.dev/v1",
		])
			expect(() => parseConfigServiceOrigin(bad)).toThrow(/origin/u);
	});
});
