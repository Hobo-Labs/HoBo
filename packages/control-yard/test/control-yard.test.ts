import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "@hobo/core/total-access";
import {
	connectionAuthorize,
	connectionCreate,
	createManagementContext,
	projectYardSnapshot,
	stationInit,
	stationUp,
} from "@hobo/management";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertSheetFitsFrames,
	boAnimationForVisual,
	buildBootLoadPlan,
	confirmSheet,
	createYardEngine,
	describeYardSceneLoad,
	expectedSheetPixelSize,
	HOBO_CONTROL_YARD_PACKAGE,
	isTestMode,
	loadAssetIndex,
	resolveAnimation,
	seededRandom,
	selectZoneWithSnapshot,
	sheetForConnectionCreate,
	stepToward,
	streamSheet,
	YARD_LAYOUT,
	zoneAt,
} from "../src/index.js";

const temps: string[] = [];
afterEach(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
	temps.length = 0;
});

function tempHome(): string {
	const d = mkdtempSync(join(tmpdir(), "hobo-yard-"));
	temps.push(d);
	return d;
}

describe("@hobo/control-yard", () => {
	it("exports package id", () => {
		expect(HOBO_CONTROL_YARD_PACKAGE).toBe("@hobo/control-yard");
	});

	it("layout owns zone coordinates with no gaps in required zones", () => {
		expect(YARD_LAYOUT.width).toBe(1280);
		expect(YARD_LAYOUT.height).toBe(720);
		const ids = Object.keys(YARD_LAYOUT.zones);
		expect(ids).toEqual(
			expect.arrayContaining([
				"platformRest",
				"bootstrapDesk",
				"activeRailTrack",
				"connectionBay",
				"policyBoard",
				"costBooth",
				"errorBunker",
			]),
		);
		expect(zoneAt(190, 600)).toBe("platformRest");
	});

	it("asset index resolves Bo idle/walk by stable id; west is not mirror flag", () => {
		const index = loadAssetIndex();
		const idle = resolveAnimation(index, "bo.idle");
		expect(idle.animation.id).toBe("bo.idle");
		expect(idle.sheet.frameWidth).toBe(207);
		expect(idle.sheet.frameHeight).toBe(230);

		const east = resolveAnimation(index, "bo.walk.east");
		expect(east.sheet.frameWidth).toBe(160);
		expect(east.sheet.frameMs).toBe(50);

		const west = resolveAnimation(index, "bo.walk.west");
		expect(west.sheet.neverMirrorFrom).toBe("bo-walk-east");
		expect(west.sheet.path).toContain("bo-walk-left");

		for (const sheet of Object.values(index.spritesheets)) {
			assertSheetFitsFrames(sheet);
			const size = expectedSheetPixelSize(sheet);
			expect(size.width).toBeGreaterThan(0);
			expect(size.height).toBeGreaterThan(0);
		}

		const manifest = describeYardSceneLoad(index);
		expect(manifest.sheets.some((s) => s.key === "bo-walk-west")).toBe(true);
		expect(manifest.animations.some((a) => a.key === "bo.walk.west")).toBe(
			true,
		);
	});

	it("yard engine reacts to mocked projections and opens connection sheet", () => {
		const home = tempHome();
		const ctx = createManagementContext({ hoboHome: home });
		stationInit(ctx, { name: "local", tenant: "local" });
		stationUp(ctx, "station:local");
		connectionCreate(ctx, {
			provider: "asana",
			alias: "work",
			stationId: "station:local",
		});
		connectionAuthorize(ctx, { idOrAlias: "work" });

		const snap = projectYardSnapshot(ctx, { stationId: "station:local" });
		expect(snap.ok).toBe(true);
		const engine = createYardEngine();
		const visual = engine.applySnapshot(must(snap.data, "snap.data"));
		expect(visual.connections[0]?.visual).toBe("authorized");
		expect(visual.traffic.rate).toBeGreaterThan(0);
		expect(visual.bo.animationId.startsWith("bo.")).toBe(true);
		expect(boAnimationForVisual(visual)).toBe(visual.bo.animationId);

		engine.tick(0.1);
		// particles may emit
		const sheet = selectZoneWithSnapshot(
			engine,
			"connectionBay",
			must(snap.data, "snap.data"),
		);
		expect(sheet?.kind).toMatch(/connection\./);

		const createSheet = sheetForConnectionCreate(snap.data);
		const chunks = [...streamSheet(createSheet)];
		expect(chunks.some((c) => c.type === "chunk")).toBe(true);
		expect(chunks.at(-1)?.type).toBe("done");

		const result = confirmSheet(
			createSheet,
			{
				provider: "github",
				alias: "gh",
				stationId: "station:local",
			},
			{
				connectionCreate: (input) => connectionCreate(ctx, input),
				connectionAuthorize: (input) => connectionAuthorize(ctx, input),
				stationRailsActivate: () => ({
					ok: false,
					code: "n/a",
					message: "n/a",
				}),
				stationRailsApprove: () => ({
					ok: false,
					code: "n/a",
					message: "n/a",
				}),
				stationRailsPublish: () => ({
					ok: false,
					code: "n/a",
					message: "n/a",
				}),
				doctorSnapshot: () => ({ ok: true, code: "HOBO_OK", message: "ok" }),
			},
		);
		expect(result.ok).toBe(true);
	});

	it("stepToward is frame-rate independent", () => {
		const a = stepToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 1);
		expect(a.x).toBe(50);
		expect(a.arrived).toBe(false);
		const b = stepToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 3);
		expect(b.arrived).toBe(true);
		expect(b.x).toBe(100);
	});

	it("gamedev-assets v2 index has measured backgrounds + spritesheets", () => {
		const index = loadAssetIndex();
		expect(index.meta?.version).toBe(2);
		expect(index.backgrounds?.trail?.path).toBe("trail.png");
		expect(index.spritesheets["bo-walk-west"]?.neverMirrorFrom).toBe(
			"bo-walk-east",
		);
		expect(index.spritesheets["bo-idle"]?.emptyCount).toBe(0);
		const plan = buildBootLoadPlan(index, "/assets");
		expect(plan.spritesheets.length).toBeGreaterThanOrEqual(3);
		expect(plan.animations.some((a) => a.key === "bo.walk.west")).toBe(true);
		// measured load config — STOP rule
		const walk = plan.spritesheets.find((s) => s.key === "bo-walk-east");
		expect(walk?.frameWidth).toBe(160);
		expect(walk?.frameHeight).toBe(157);
	});

	it("playwright-testing seam helpers: seed + test mode", () => {
		const { testMode, seed } = isTestMode("?test=1&seed=7");
		expect(testMode).toBe(true);
		expect(seed).toBe(7);
		const r = seededRandom(42);
		const a = r();
		const r2 = seededRandom(42);
		expect(r2()).toBe(a);
	});
});
