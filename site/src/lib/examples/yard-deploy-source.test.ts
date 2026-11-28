import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GET } from "../../pages/examples/yards-deploy.json.js";
import {
	composePoolDeploySource,
	providerImportForTarget,
} from "./yard-deploy-source-contract.js";
import { loadYardDeploySources, yardDeployByTarget } from "./yard-deploy-source.js";

describe("Yard deploy sources", () => {
	it("keeps Node fs out of the browser controller entry", async () => {
		const controllerPath = fileURLToPath(new URL("./controller.ts", import.meta.url));
		const contractPath = fileURLToPath(
			new URL("./yard-deploy-source-contract.ts", import.meta.url),
		);
		const controller = await readFile(controllerPath, "utf8");
		const contract = await readFile(contractPath, "utf8");
		expect(controller).toContain("yard-deploy-source-contract");
		expect(controller).not.toContain('from "./yard-deploy-source.js"');
		expect(controller).not.toContain("node:fs");
		expect(contract).not.toContain("node:fs");
	});

	it("keeps yard deploy surfaces as minimal provider re-exports", async () => {
		const sources = await loadYardDeploySources();
		for (const entry of sources) {
			expect(entry.source, entry.targetId).not.toMatch(/\bwaspApp\b/u);
			expect(entry.source, entry.targetId).not.toMatch(/\bcli\s*:/u);
			expect(entry.source, entry.targetId).not.toMatch(
				/examples\/try-site\/apps\//u,
			);
			expect(entry.source, entry.targetId).not.toMatch(/wasp-opensaas/u);
			expect(entry.source, entry.targetId).not.toMatch(/\bstationBootstrap\b/u);
			expect(entry.source, entry.targetId).not.toMatch(/\bcapabilities\s*:/u);
			expect(entry.source, entry.targetId).not.toMatch(/\bresourceClass\s*:/u);
			expect(entry.source, entry.targetId).toMatch(/export\s*\{/u);
			expect(entry.source, entry.targetId).toMatch(/\bas default\b/u);
		}
	});

	it("loads every Pool target deploy surface from the repository", async () => {
		const sources = await loadYardDeploySources();
		const map = yardDeployByTarget(sources);
		expect(map.has("cloudflare")).toBe(true);
		expect(map.has("railway")).toBe(false);
		expect(map.has("vercel")).toBe(true);
		expect(map.get("cloudflare")?.source).toContain("@hobo/provider-cloudflare");
		expect(map.get("vercel")?.source).toContain("@hobo/provider-vercel");
	});

	it("maps Pool targets to provider extension package imports", () => {
		expect(providerImportForTarget("cloudflare")).toEqual({
			packageName: "@hobo/provider-cloudflare",
			exportName: "cloudflare",
		});
		expect(providerImportForTarget("browser-wasm")).toEqual({
			packageName: "@hobo/provider-browser-wasm",
			exportName: "browserWasm",
		});
	});

	it("synthesizes station({ yards }) authoring for the provision plan", () => {
		const composed = composePoolDeploySource({
			provision: [
				{ target: { id: "browser-wasm" } },
				{ target: { id: "cloudflare" } },
			],
		});
		expect(composed.pathLabel).toBe("examples/try-site/station.deploy.ts");
		expect(composed.source).toContain('import { station } from "@hobo/stations"');
		expect(composed.source).toContain(
			'import { browserWasm } from "@hobo/provider-browser-wasm"',
		);
		expect(composed.source).toContain(
			'import { cloudflare } from "@hobo/provider-cloudflare"',
		);
		expect(composed.source).toContain("yards: [browserWasm, cloudflare]");
		expect(composed.source).not.toMatch(/\bcapabilities\b/u);
		expect(composed.source).not.toMatch(/\bstationBootstrap\b/u);
	});

	it("prerenders yards-deploy.json for the console", async () => {
		// SAFETY: Astro endpoint tests only need an empty context bag.
		const response = await GET({} as never);
		type DeployRow = { targetId: string };
		// SAFETY: yards-deploy JSON is decoded as target rows at this test boundary.
		const body = (await response.json()) as DeployRow[];
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(body.map((entry) => entry.targetId)).toEqual(
			expect.arrayContaining(["browser-wasm", "cloudflare", "vercel"]),
		);
	});
});
