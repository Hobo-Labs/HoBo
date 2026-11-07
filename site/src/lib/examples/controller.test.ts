import { describe, expect, it } from "vitest";

import { loadExamplesCatalog } from "./catalog.js";
import {
	allYardUiTargetIds,
	buildYardUiOptions,
	composePoolDeploySource,
	defaultSelectedStationIds,
	defaultSelectedTargetIds,
	HOST_SANDBOX_TOKENS,
	mapConcurrent,
	normalizeBase,
	pickSourceFocusId,
	resolveExampleDeployPlan,
	resolveExampleStationPlan,
	resolveStageSourceFocusId,
	resolveStationDeployPlan,
	SHIP_GATE_PLAN_LINE,
	SHIP_LOCKED_DEPLOY_LABEL,
	SHIP_RUNTIME_MISSING_LINE,
	preferShipExampleId,
	shipStationsReady,
	targetPackCanHostNow,
	toggleYardUiOption,
	yardOptionSelectionState,
	yardSelectionSummary,
} from "./controller.js";
import { resolveDemoPolicy } from "./demo-policies.js";
import type { DeployedStation } from "./station-registry.js";
import { loadYardDeploySources } from "./yard-deploy-source.js";

describe("Examples Home Station", () => {
	it("normalizes the GitHub Pages base before building static URLs", () => {
		expect(normalizeBase("/HoBo")).toBe("/HoBo/");
		expect(normalizeBase("/HoBo/")).toBe("/HoBo/");
		expect(normalizeBase(undefined)).toBe("/");
	});

	it("grants blob hosts scripts only", () => {
		expect(HOST_SANDBOX_TOKENS).toEqual(["allow-scripts"]);
	});

	it("plans station deploy from the provider pool with demo policy presets", async () => {
		const catalog = await loadExamplesCatalog();
		const yards = catalog[0]!.topology.yards;
		const localOnly = resolveStationDeployPlan(
			yards,
			new Set(["browser-wasm", "webernetes", "cloudflare"]),
			"local-only",
		);
		// Selecting Cloudflare widens the pool — operator stamps are not blocked.
		expect(localOnly.policy.resourcePool).toEqual(
			expect.arrayContaining(["local", "anonymous-remote"]),
		);
		expect(localOnly.provision.map(({ target }) => target.id).sort()).toEqual([
			"browser-wasm",
			"cloudflare",
			"webernetes",
		]);
		expect(localOnly.skipped.find(({ target }) => target.id === "cloudflare")).toBeUndefined();
		expect(targetPackCanHostNow("cloudflare")).toBe(true);
		expect(targetPackCanHostNow("lakebed")).toBe(true);
		expect(targetPackCanHostNow("netlify")).toBe(true);
		expect(targetPackCanHostNow("vercel")).toBe(false);


		const multi = resolveStationDeployPlan(
			yards,
			new Set(["browser-wasm", "webernetes", "lakebed"]),
			"cost-first-multi",
		);
		expect(multi.provision).toHaveLength(3);
	});

	it("prefers a local-bridge app when Pages omits the WIT runtime", async () => {
		const catalog = await loadExamplesCatalog();
		expect(preferShipExampleId(catalog, true)).toBe(catalog[0]?.id);
		const preferred = preferShipExampleId(catalog, false);
		const picked = catalog.find((entry) => entry.id === preferred);
		expect(picked?.deployKind).toBe("local-bridge");
		expect(SHIP_RUNTIME_MISSING_LINE).toContain("examples:bridge");
	});

	it("gates example deploy onto deployed stations only", async () => {
		const catalog = await loadExamplesCatalog();
		const hello = catalog.find(({ id }) => id === "hello-world")!;
		const stations: DeployedStation[] = [
			{
				id: "station:browser:home:browser-wasm",
				targetId: "browser-wasm",
				yardId: "yard:browser-wasm",
				providerId: "browser-wasm",
				policy: resolveDemoPolicy("local-only"),
				label: "Browser WASM",
				createdAt: "2026-08-05T00:00:00.000Z",
			},
			{
				id: "station:browser:home:webernetes",
				targetId: "webernetes",
				yardId: "yard:webernetes",
				providerId: "webernetes",
				policy: resolveDemoPolicy("local-only"),
				label: "Webernetes (local)",
				createdAt: "2026-08-05T00:00:00.000Z",
			},
		];

		expect([...defaultSelectedStationIds(hello, stations)]).toEqual([
			"station:browser:home:browser-wasm",
			"station:browser:home:webernetes",
		]);
		// Empty appPolicy → single primary; both stations stay selected for Ship.
		expect(
			resolveExampleStationPlan(hello, stations).provision.map(({ target }) => target.id),
		).toEqual(["browser-wasm"]);
		expect(resolveExampleStationPlan(hello, []).provision).toEqual([]);
	});

	it("keeps repository policy fixtures for example→yard planning", async () => {
		const catalog = await loadExamplesCatalog();
		const plans = Object.fromEntries(
			catalog.map((example) => [
				example.id,
				resolveExampleDeployPlan(example).provision.map(({ target, role }) => [
					target.id,
					role,
				]),
			]),
		);

		expect(plans["hello-world"]).toEqual([["browser-wasm", "primary"]]);
		expect(plans["todo-api"]).toEqual([["browser-wasm", "primary"]]);
		expect(plans["opensaas"]).toEqual([["webernetes", "primary"]]);
		expect(plans["swaghaus"]).toEqual([["cloudflare", "primary"]]);
	});

	it("defaults Pool selection to every hostable yard", async () => {
		const catalog = await loadExamplesCatalog();
		const yards = catalog[0]!.topology.yards;
		const { defaultPoolTargetIds } = await import("./controller.js");
		expect([...defaultPoolTargetIds(yards)].sort()).toEqual(
			[
				"browser-wasm",
				"cloudflare",
				"lakebed",
				"netlify",
				"webernetes",
			].sort(),
		);
	});

	it("selects only Yard-allowed candidates and refuses unavailable anonymous Vercel hosting", async () => {
		const catalog = await loadExamplesCatalog();
		const hello = catalog.find(({ id }) => id === "hello-world")!;
		const saas = catalog.find(({ id }) => id === "opensaas")!;

		expect([...defaultSelectedTargetIds(hello)].sort()).toEqual(
			[
				"browser-wasm",
				"cloudflare",
				"lakebed",
				"netlify",
				"vercel",
				"webernetes",
			].sort(),
		);
		const helloCf = resolveExampleDeployPlan(hello).skipped.find(
			({ target }) => target.id === "cloudflare",
		);
		// Cloudflare is hostable; may still be skipped for budget/role reasons, never cannot-host.
		if (helloCf) expect(helloCf.reason).not.toBe("cannot-host");
		expect(saas.topology.allowedYardIds).toEqual([
			"yard:webernetes",
			"yard:lakebed",
			"yard:cloudflare",
			"yard:vercel",
		]);
		expect(targetPackCanHostNow("cloudflare")).toBe(true);
		expect(targetPackCanHostNow("vercel")).toBe(false);
 expect(resolveExampleDeployPlan(hello).skipped).toContainEqual(expect.objectContaining({target:expect.objectContaining({id:"vercel"}),reason:"cannot-host"}));
	});

	it("loads yard deploy surfaces for Pool Code", async () => {
		const sources = await loadYardDeploySources();
		const byId = Object.fromEntries(sources.map((entry) => [entry.targetId, entry]));
		expect(byId.cloudflare?.sourcePath).toBe(
			"examples/try-site/yards/cloudflare.deploy.ts",
		);
		expect(byId.railway).toBeUndefined();
		expect(byId.vercel?.source).toContain("@hobo/provider-vercel");
		expect(byId.cloudflare?.source).not.toMatch(/\bcli\s*:/);
		expect(byId.cloudflare?.source).toContain("@hobo/provider-cloudflare");
		expect(byId["browser-wasm"]?.source).toContain("browserWasm");
	});

	it("merges Browser WASM + Webernetes into one Local yard option", async () => {
		const catalog = await loadExamplesCatalog();
		const options = buildYardUiOptions(catalog[0]!.topology.yards);
		const local = options.find((option) => option.id === "local");
		expect(local?.targetIds).toEqual(["browser-wasm", "webernetes"]);
		expect(options.some((option) => option.id === "browser-wasm")).toBe(false);
		expect(options.some((option) => option.id === "webernetes")).toBe(false);
		expect(options.some((option) => option.id === "cloudflare")).toBe(true);

		const none = new Set<string>();
		const both = toggleYardUiOption(none, local!);
		expect([...both].sort()).toEqual(["browser-wasm", "webernetes"]);
		expect(yardOptionSelectionState(local!, both)).toBe("all");
		// Local is one UI option covering two stations — summary names the count.
		expect(yardSelectionSummary(options, both)).toBe("Local · 2 stations");
		expect(toggleYardUiOption(both, local!).size).toBe(0);
		const allIds = new Set(allYardUiTargetIds(options));
		expect(allIds.size).toBe(6);
		expect(yardSelectionSummary(options, allIds)).toBe("All · 6 stations");
		expect(allYardUiTargetIds(options)).toEqual(
			expect.arrayContaining(["browser-wasm", "webernetes", "cloudflare"]),
		);
		expect(allYardUiTargetIds(options)).not.toContain("kubernetes");
		expect(options.some((option) => option.id === "kubernetes")).toBe(false);
	});

	it("composes Pool Code as station({ yards }) from the provision plan", async () => {
		const catalog = await loadExamplesCatalog();
		const yards = catalog[0]!.topology.yards;
		const plan = resolveStationDeployPlan(
			yards,
			new Set(["browser-wasm", "webernetes", "cloudflare"]),
			"local-only",
		);
		const composed = composePoolDeploySource({
			provision: plan.provision,
		});
		expect(plan.provision.map(({ target }) => target.id).sort()).toEqual([
			"browser-wasm",
			"cloudflare",
			"webernetes",
		]);
		expect(composed.pathLabel).toBe("examples/try-site/station.deploy.ts");
		expect(composed.source).toContain('import { station } from "@hobo/stations"');
		expect(composed.source).toContain("@hobo/provider-browser-wasm");
		expect(composed.source).toContain("@hobo/provider-webernetes");
		expect(composed.source).toContain("@hobo/provider-cloudflare");
		expect(composed.source).toContain("browserWasm");
		expect(composed.source).toContain("webernetes");
		expect(composed.source).toContain("cloudflare");
		expect(composed.source).toMatch(/export default station\(\{\s*yards:/);
		expect(composed.source).not.toMatch(/\bstationBootstrap\b/);
		expect(composed.source).not.toMatch(/\bcapabilities\b/);
	});

	it("waits for in-flight bootstrap workers before a failed deployment rejects", async () => {
		let inFlightFinished = false;
		await expect(
			mapConcurrent(["fail", "slow"], 2, async (value) => {
				if (value === "fail") throw new Error("bootstrap failed");
				await new Promise((resolve) => setTimeout(resolve, 10));
				inFlightFinished = true;
			}),
		).rejects.toThrow("bootstrap failed");
		expect(inFlightFinished).toBe(true);
	});

	it("keeps Stage Source focused on the last selected app (OpenSaaS over hello-world)", async () => {
		const catalog = await loadExamplesCatalog();
		const selected = new Set(["hello-world", "opensaas"]);
		expect(pickSourceFocusId(selected, "opensaas", "hello-world")).toBe("opensaas");
		expect(pickSourceFocusId(selected, "hello-world", "hello-world")).toBe("hello-world");
		expect(pickSourceFocusId(new Set(["opensaas"]), "hello-world", "hello-world")).toBe(
			"opensaas",
		);
		const focusId = pickSourceFocusId(selected, "opensaas", catalog[0]!.id);
		const focus = catalog.find((example) => example.id === focusId);
		expect(focus?.source).toContain("b.container");
		expect(focus?.source).toContain("waspApp(");
		expect(focus?.source).toContain("examples/wasp-opensaas/app");
		expect(focus?.source).not.toContain("hobo/opensaas-");
		expect(focus?.deployKind).toBe("local-bridge");
		expect(focus?.bindleContainers.map((c) => c.name)).toEqual(["db"]);
		expect(focus?.bindleWebApp?.framework).toBe("wasp");
		expect(focus?.bindleWebApp?.root).toBe("examples/wasp-opensaas/app");
	});

	it("prefers the active live host over Ship selection for Stage Source", async () => {
		const catalog = await loadExamplesCatalog();
		const selected = new Set(["hello-world", "opensaas"]);
		expect(
			resolveStageSourceFocusId({
				selected,
				sourceFocusId: "hello-world",
				fallbackId: "hello-world",
				activeLiveExampleId: "opensaas",
			}),
		).toBe("opensaas");
		const focus = catalog.find(
			(example) =>
				example.id ===
				resolveStageSourceFocusId({
					selected,
					sourceFocusId: "hello-world",
					fallbackId: catalog[0]!.id,
					activeLiveExampleId: "opensaas",
				}),
		);
		expect(focus?.source).toContain("b.container");
		expect(focus?.source).not.toContain("@trainable");
	});

	it("hosts browser-wasm stations in-page on static hosts with the WIT runtime", async () => {
		const { canHostStationInPage, IN_PAGE_STATION_TARGETS } = await import(
			"./controller.js"
		);
		expect(IN_PAGE_STATION_TARGETS).toEqual(["browser-wasm"]);
		expect(canHostStationInPage("browser-wasm", true)).toBe(true);
		// No runtime assets (stripped Pages deploy) → no in-page station.
		expect(canHostStationInPage("browser-wasm", false)).toBe(false);
		// Remote yards never host in-page — fail closed toward remediation.
		expect(canHostStationInPage("cloudflare", true)).toBe(false);
		expect(canHostStationInPage("webernetes", true)).toBe(false);
	});

	it("treats partial Pool provision as success, zero stations as failure", async () => {
		const { poolDeployOutcome } = await import("./controller.js");
		expect(poolDeployOutcome(1, []).state).toBe("stations-ready");
		const partial = poolDeployOutcome(1, ["cloudflare", "vercel"]);
		expect(partial.state).toBe("stations-ready");
		expect(partial.line).toContain("cloudflare, vercel");
		const failed = poolDeployOutcome(0, ["cloudflare"]);
		expect(failed.state).toBe("failed");
		expect(failed.line).toContain("no Environment Stations");
	});

	it("hard-locks Ship until registry.stations.length > 0", async () => {
		const catalog = await loadExamplesCatalog();
		const hello = catalog.find(({ id }) => id === "hello-world")!;
		expect(shipStationsReady(0)).toBe(false);
		expect(shipStationsReady(1)).toBe(true);
		expect(SHIP_LOCKED_DEPLOY_LABEL).toBe("Locked — deploy stations first");
		expect(SHIP_GATE_PLAN_LINE).toBe("Deploy at least one station in Pool first.");
		expect(resolveExampleStationPlan(hello, []).provision).toEqual([]);
	});

	it("keeps hello Source as minimal plain web Bindle (no trainable)", async () => {
		const catalog = await loadExamplesCatalog();
		const hello = catalog.find(({ id }) => id === "hello-world")!;
		expect(hello.source.trimStart().startsWith("import")).toBe(true);
		expect(hello.source).toContain("b.web()");
		expect(hello.source).not.toContain("@trainable");
		expect(hello.source).not.toContain("guest handlers");
		expect(hello.source).toContain("export const runtime");
	});

	it("keeps todo Source as trainable Todos on b.web", async () => {
		const catalog = await loadExamplesCatalog();
		const todos = catalog.find(({ id }) => id === "todo-api")!;
		expect(todos.source).toContain("@trainable");
		expect(todos.source).toContain("b.web(Todos)");
		expect(todos.source).not.toContain("export const runtime");
		expect(todos.handlersSource).toBe("");
	});
});
