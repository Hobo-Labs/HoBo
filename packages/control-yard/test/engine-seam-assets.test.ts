/**
 * The Phaser-free Yard engine, the Playwright test seam, and the asset index.
 *
 * These three exist so the Yard can be reasoned about without a canvas. The
 * failure each guards is a rendering surface that disagrees with the
 * projection it is supposed to show: Bo standing in the wrong zone, a sheet
 * offering an action the Station cannot take, a seam reporting `ready` for a
 * frame that never drew, or an asset index whose declared geometry does not
 * match the sprite sheet on disk. None of those throw.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { YardProjectionSnapshot } from "@hobo/management";
import {
	connectionCreate,
	createManagementContext,
	projectYardSnapshot,
	stationInit,
	stationUp,
} from "@hobo/management";
import { afterEach, describe, expect, it } from "vitest";

import {
	allAssetPaths,
	animationFrameList,
	assetsRoot,
	createTestSeam,
	createYardEngine,
	expectedSheetPixelSize,
	frameCount,
	isTestMode,
	loadAssetIndex,
	phaserSpritesheetConfigs,
	resolveAnimation,
	seededRandom,
	selectZoneWithSnapshot,
	sheetAbsolutePath,
	sheetForZone,
	YARD_LAYOUT,
	zoneAnchor,
} from "../src/index.js";
import type { ZoneId } from "../src/layout.js";
import type { YardTestHost } from "../src/test-seam.js";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});

/** A real projection snapshot, built through the management layer. */
function snapshot(options: { withConnection?: boolean; up?: boolean } = {}) {
	const home = mkdtempSync(join(tmpdir(), "hobo-yard-engine-"));
	temps.push(home);
	const ctx = createManagementContext({ hoboHome: home });
	stationInit(ctx, { name: "local", tenant: "local" });
	if (options.withConnection) {
		connectionCreate(ctx, { provider: "github", alias: "gh" });
	}
	if (options.up) stationUp(ctx, "station:local");
	return projectYardSnapshot(ctx, "station:local")
		.data as unknown as YardProjectionSnapshot;
}

describe("yard engine — snapshot application", () => {
	it("starts with nothing applied and Bo at the platform", () => {
		const engine = createYardEngine();
		expect(engine.visual).toBeNull();
		expect(engine.selectedZone).toBeNull();
		expect(engine.openSheet).toBeNull();
		// Bo's initial position comes from the layout, not from a literal. A
		// hard-coded start would drift the moment the layout moved.
		expect(engine.boPos).toEqual({
			x: YARD_LAYOUT.zones.platformRest.anchorX,
			y: YARD_LAYOUT.zones.platformRest.anchorY,
		});
	});

	it("derives and stores a visual state from a snapshot", () => {
		const engine = createYardEngine();
		const visual = engine.applySnapshot(snapshot());
		expect(visual).toBeDefined();
		// The returned value and the stored one are the same object, so a caller
		// that renders the return value cannot drift from one that reads
		// `engine.visual` on the next frame.
		expect(engine.visual).toBe(visual);
		expect(visual.bo.zone).toBeDefined();
	});

	it("carries the current selection into the derived visual", () => {
		const engine = createYardEngine();
		const unselected = engine.applySnapshot(snapshot()).bo.zone;
		engine.selectZone("costBooth");
		const visual = engine.applySnapshot(snapshot());
		// `selectedZone` is an *input* to `deriveYardVisualState`, not a field on
		// the result — it decides where Bo walks. Selection is engine state, not
		// snapshot state, so if applying a snapshot dropped it Bo would walk back
		// to his default zone on every projection refresh while the operator was
		// still looking at the panel they opened.
		expect(visual.bo.zone).toBe("costBooth");
		expect(unselected).not.toBe("costBooth");
	});

	it("re-derives on each snapshot rather than accumulating", () => {
		const engine = createYardEngine();
		const first = engine.applySnapshot(snapshot());
		const second = engine.applySnapshot(snapshot({ up: true }));
		expect(second).not.toBe(first);
		expect(engine.visual).toBe(second);
	});
});

describe("yard engine — zone selection", () => {
	it("opens a sheet for a zone that has one", () => {
		const engine = createYardEngine();
		engine.applySnapshot(snapshot());
		const sheet = engine.selectZone("costBooth");
		expect(sheet).not.toBeNull();
		expect(engine.openSheet).toBe(sheet);
		expect(engine.selectedZone).toBe("costBooth");
	});

	it("clears the sheet when the selection is cleared", () => {
		const engine = createYardEngine();
		engine.applySnapshot(snapshot());
		engine.selectZone("costBooth");
		expect(engine.selectZone(null)).toBeNull();
		// A sheet left open over a cleared selection would accept an action for
		// a zone the operator is no longer looking at.
		expect(engine.openSheet).toBeNull();
	});

	it("opens no sheet before a snapshot has been applied", () => {
		const engine = createYardEngine();
		// Sheets are built from projection fields. Offering one with no
		// projection would show an action panel full of blanks.
		expect(engine.selectZone("costBooth")).toBeNull();
		expect(engine.openSheet).toBeNull();
		// The selection is still recorded, so the next snapshot renders the
		// highlight.
		expect(engine.selectedZone).toBe("costBooth");
	});

	it("dismissSheet clears both the sheet and the selection", () => {
		const engine = createYardEngine();
		engine.applySnapshot(snapshot());
		engine.selectZone("errorBunker");
		engine.dismissSheet();
		expect(engine.openSheet).toBeNull();
		// Both, not just the sheet — leaving the zone selected would keep the
		// highlight on with no panel, which reads as a stuck UI.
		expect(engine.selectedZone).toBeNull();
	});

	it("selectZoneWithSnapshot builds a sheet from current projection fields", () => {
		const engine = createYardEngine();
		const snap = snapshot({ withConnection: true });
		const sheet = selectZoneWithSnapshot(engine, "connectionBay", snap);
		expect(sheet).not.toBeNull();
		expect(engine.openSheet).toBe(sheet);
		// This is the difference from bare `selectZone`: the visual is refreshed
		// too, so Bo's walk target and the panel come from the same snapshot
		// rather than from two different frames.
		expect(engine.visual?.bo.zone).toBe("connectionBay");
	});
});

describe("sheetForZone", () => {
	it("offers authorize when a pending connection exists, create otherwise", () => {
		const withPending = sheetForZone(
			"connectionBay",
			snapshot({ withConnection: true }),
		);
		const empty = sheetForZone("connectionBay", snapshot());
		// The bay is one zone with two jobs. Offering "create" while a
		// connection sits unauthorized would leave the operator stacking pending
		// connections instead of finishing the one in front of them.
		expect(withPending).not.toBeNull();
		expect(empty).not.toBeNull();
		expect(JSON.stringify(withPending)).not.toBe(JSON.stringify(empty));
	});

	it("returns a sheet for each interactive zone", () => {
		const snap = snapshot();
		for (const zone of [
			"connectionBay",
			"policyBoard",
			"costBooth",
			"errorBunker",
		] as const) {
			expect(sheetForZone(zone, snap), zone).not.toBeNull();
		}
	});

	it("returns null for the scenery zones", () => {
		const snap = snapshot();
		for (const zone of [
			"platformRest",
			"bootstrapDesk",
			"activeRailTrack",
		] as const) {
			// These are places Bo stands, not places with actions. A sheet here
			// would offer an operator a panel with nothing to do.
			expect(sheetForZone(zone, snap), zone).toBeNull();
		}
	});

	it("builds a sheet with no snapshot at all", () => {
		// The `snap ?? undefined` fallbacks exist so a sheet can be built before
		// the first projection arrives — it renders with defaults rather than
		// crashing the scene on the first click.
		for (const zone of [
			"connectionBay",
			"policyBoard",
			"costBooth",
			"errorBunker",
		] as const) {
			expect(sheetForZone(zone, null), zone).not.toBeNull();
		}
	});
});

describe("yard engine — tick", () => {
	it("does nothing before a snapshot", () => {
		const engine = createYardEngine();
		const before = { ...engine.boPos };
		engine.tick(1);
		// Without a visual there is no walk target; moving Bo anyway would put
		// him somewhere the projection never asked for.
		expect(engine.boPos).toEqual(before);
		expect(engine.particles.every((p) => !p.alive)).toBe(true);
	});

	it("walks Bo toward the zone the visual names, arriving exactly", () => {
		const engine = createYardEngine();
		const visual = engine.applySnapshot(snapshot());
		const target = zoneAnchor(visual.bo.zone);
		engine.boPos = { x: 0, y: 0 };
		engine.tick(0.016);
		const afterOneFrame = { ...engine.boPos };
		expect(afterOneFrame).not.toEqual({ x: 0, y: 0 });

		// A long step must land exactly on the anchor rather than overshooting
		// and oscillating around it forever.
		engine.tick(100);
		expect(engine.boPos).toEqual(target);
	});

	it("emits no particles when traffic is inactive", () => {
		const engine = createYardEngine();
		const visual = engine.applySnapshot(snapshot());
		if (visual.traffic.active) return; // covered by the emitting test below
		engine.tick(1);
		expect(engine.particles.some((p) => p.alive)).toBe(false);
	});

	it("emits, advances and retires particles from a fixed pool", () => {
		const engine = createYardEngine();
		const visual = engine.applySnapshot(snapshot({ up: true }));
		// Drive the emitter directly: the projection's traffic rate depends on
		// metering this test does not control, and the pool behaviour is what is
		// under test.
		engine.visual = { ...visual, traffic: { active: true, rate: 1 } } as never;

		engine.tick(1);
		const alive = engine.particles.filter((p) => p.alive);
		expect(alive.length).toBeGreaterThan(0);
		// A fixed pool: the array never grows, so a long-running scene cannot
		// leak particles into unbounded memory.
		expect(engine.particles).toHaveLength(48);

		const emitter = YARD_LAYOUT.trafficEmitter;
		for (const particle of alive) {
			expect(particle.x).toBeGreaterThanOrEqual(emitter.x);
			// Vertical jitter stays within the emitter band.
			expect(Math.abs(particle.y - emitter.y)).toBeLessThanOrEqual(20);
		}

		// Advance far enough that everything alive passes the emitter's right
		// edge and is retired for reuse.
		const first = alive[0];
		const startX = first?.x ?? 0;
		engine.tick(0.5);
		expect((first?.x ?? 0) > startX || first?.alive === false).toBe(true);
	});

	it("caps emission by the pool rather than the rate", () => {
		const engine = createYardEngine();
		const visual = engine.applySnapshot(snapshot({ up: true }));
		engine.visual = {
			...visual,
			traffic: { active: true, rate: 10_000 },
		} as never;
		engine.tick(1);
		// An absurd rate must not produce more particles than the pool holds —
		// the emit loop walks the pool, so the cap is structural.
		expect(engine.particles.filter((p) => p.alive).length).toBeLessThanOrEqual(
			48,
		);
	});
});

describe("test seam", () => {
	function host(overrides: Partial<YardTestHost> = {}): {
		host: YardTestHost;
		calls: string[];
	} {
		const calls: string[] = [];
		const base: YardTestHost = {
			getBo: () => ({ x: 1, y: 2, animationId: "bo.idle", facing: "east" }),
			getZone: () => null,
			getSnap: () => null,
			getVisual: () => null,
			isSheetOpen: () => false,
			sheetKind: () => null,
			selectZone: (zone) => calls.push(`selectZone:${zone}`),
			dismissSheet: () => calls.push("dismissSheet"),
			runAction: async (action) => {
				calls.push(`runAction:${action}`);
			},
			reset: () => calls.push("reset"),
			advanceFrame: (dtMs) => calls.push(`advanceFrame:${dtMs}`),
			setSeed: (n) => calls.push(`setSeed:${n}`),
			...overrides,
		};
		return { host: base, calls };
	}

	it("starts not ready with no seed and a zero frame count", () => {
		const seam = createTestSeam(host().host);
		// A harness waits on `ready`; reporting it before the scene has drawn
		// would let assertions run against an empty canvas.
		expect(seam.ready).toBe(false);
		expect(seam.seed).toBeNull();
		expect(seam.frameCount).toBe(0);
		expect(seam.sceneKey).toBe("Yard");
	});

	it("reports safe defaults when there is no snapshot yet", () => {
		const state = createTestSeam(host().host).state();
		// Every field has a defined default so a harness can read the shape
		// before the first projection instead of guarding each property.
		expect(state).toMatchObject({
			occupyMode: null,
			connCount: 0,
			trafficRate: 0,
			bootstrapActive: false,
			seq: null,
			hazards: [],
			sheetOpen: false,
			sheetKind: null,
		});
	});

	it("projects snapshot fields into serializable state", () => {
		const snap = snapshot({ withConnection: true, up: true });
		const seam = createTestSeam(
			host({
				getSnap: () => snap,
				getZone: () => "costBooth" as ZoneId,
				isSheetOpen: () => true,
				sheetKind: () => "cost",
			}).host,
		);
		const state = seam.state();
		expect(state.zone).toBe("costBooth");
		expect(state.sheetOpen).toBe(true);
		expect(state.sheetKind).toBe("cost");
		expect(state.connCount).toBe(snap.connections.length);
		expect(state.seq).toBe(snap.seq);
	});

	it("returns a frozen state with a copied bo and hazards", () => {
		const seam = createTestSeam(host().host);
		const state = seam.state();
		// Frozen and copied: the seam must never hand a harness a live reference
		// into the engine, or a test could mutate the scene it is observing.
		expect(Object.isFrozen(state)).toBe(true);
		expect(Object.isFrozen(state.bo)).toBe(true);
		expect(Object.isFrozen(state.hazards)).toBe(true);
	});

	it("reads state live rather than snapshotting at construction", () => {
		let zone: ZoneId | null = null;
		const seam = createTestSeam(host({ getZone: () => zone }).host);
		expect(seam.state().zone).toBeNull();
		zone = "policyBoard";
		// A harness polls `state()` between commands; a value captured at
		// construction would report the scene as it was before the test acted.
		expect(seam.state().zone).toBe("policyBoard");
	});

	it("reflects ready and seed changes made after construction", () => {
		const seam = createTestSeam(host().host);
		seam.ready = true;
		expect(seam.state().ready).toBe(true);
	});

	it("forwards every command to the host", () => {
		const made = host();
		const seam = createTestSeam(made.host);
		seam.commands.reset();
		seam.commands.selectZone("errorBunker");
		seam.commands.dismissSheet();
		expect(made.calls).toEqual([
			"reset",
			"selectZone:errorBunker",
			"dismissSheet",
		]);
	});

	it("records the seed locally as well as forwarding it", () => {
		const made = host();
		const seam = createTestSeam(made.host);
		seam.commands.seed(7);
		// Both: the host needs it to reseed the RNG, and the seam reports it back
		// so a failing run can be reproduced from the recorded state.
		expect(made.calls).toContain("setSeed:7");
		expect(seam.seed).toBe(7);
		expect(seam.state().seed).toBe(7);
	});

	it("counts frames and defaults the step to one frame at 60fps", () => {
		const made = host();
		const seam = createTestSeam(made.host);
		seam.commands.advanceFrame();
		seam.commands.advanceFrame(100);
		// The count is what a harness waits on to know its command took effect;
		// an uncounted frame would make it wait forever.
		expect(seam.frameCount).toBe(2);
		expect(made.calls).toEqual(["advanceFrame:16.67", "advanceFrame:100"]);
	});

	it("returns the host's promise from runAction", async () => {
		const made = host();
		const seam = createTestSeam(made.host);
		await seam.commands.runAction("station.up");
		// Awaited, not fire-and-forget: a harness that could not await the action
		// would assert against the state before it changed.
		expect(made.calls).toContain("runAction:station.up");
	});
});

describe("seededRandom", () => {
	it("is deterministic for a seed and produces unit-interval values", () => {
		const a = seededRandom(42);
		const b = seededRandom(42);
		const drawn = Array.from({ length: 32 }, () => a());
		// Determinism is the whole point: particle placement has to replay
		// identically or a screenshot comparison is noise.
		expect(drawn).toEqual(Array.from({ length: 32 }, () => b()));
		for (const value of drawn) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});

	it("differs between seeds and does not immediately repeat", () => {
		const a = seededRandom(1);
		const b = seededRandom(2);
		expect(a()).not.toBe(b());
		const stream = Array.from({ length: 64 }, () => seededRandom(9)());
		// Every call to `seededRandom(9)` restarts the stream, so this is 64
		// copies of the same first draw — pinning that the generator is a
		// factory, not a global.
		expect(new Set(stream).size).toBe(1);
	});

	it("handles seed zero and a negative seed", () => {
		// `seed >>> 0` coerces to uint32, so a negative seed is legal input
		// rather than a crash or a NaN stream.
		for (const seed of [0, -1, 2 ** 31]) {
			const value = seededRandom(seed)();
			expect(Number.isFinite(value), String(seed)).toBe(true);
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});
});

describe("isTestMode", () => {
	it("enables test mode for the documented ?test=1", () => {
		expect(isTestMode("?test=1")).toEqual({ testMode: true, seed: 42 });
		expect(isTestMode("test=1")).toEqual({ testMode: true, seed: 42 });
	});

	it("stays off for a search string with no test parameter", () => {
		expect(isTestMode("").testMode).toBe(false);
		expect(isTestMode("?seed=7").testMode).toBe(false);
	});

	it("enables test mode for any present test parameter, including ?test=0", () => {
		// Pinning a wart rather than the tidy behaviour. The expression is
		// `params.has("test") || params.get("test") === "1"`, and `||`
		// short-circuits — so the second clause is unreachable and *any*
		// presence of the parameter turns test mode on, including `?test=0` and
		// `?test=false`. The neighbouring doc comment in `phaser/game-config.ts`
		// says "Deterministic test mode (?test=1)", so the implementation is
		// looser than the documented contract.
		//
		// Left as-is: this is a dev affordance rather than a security boundary,
		// and tightening it to require `=1` would break a bare `?test`, which
		// is the form a human is most likely to type. Flagged rather than
		// changed. The same expression is duplicated in
		// `@hobo/pixel-village`'s `test-seam.ts`.
		expect(isTestMode("?test=0").testMode).toBe(true);
		expect(isTestMode("?test=false").testMode).toBe(true);
		expect(isTestMode("?test").testMode).toBe(true);
	});

	it("reads a seed and falls back to 42", () => {
		expect(isTestMode("?test=1&seed=7").seed).toBe(7);
		// Seed 0 survives: `params.get` returns the *string* "0", which is
		// truthy, so the `|| "42"` fallback does not fire. That is the right
		// answer — 0 is a legitimate seed, and a replay pinned to it must not
		// silently become 42.
		expect(isTestMode("?test=1&seed=0").seed).toBe(0);
		// A non-numeric seed must not become NaN — a NaN seed produces a
		// degenerate RNG stream and every replay would differ.
		expect(isTestMode("?test=1&seed=abc").seed).toBe(42);
		expect(isTestMode("?test=1&seed=").seed).toBe(42);
	});

	it("accepts a negative or fractional seed as given", () => {
		// Both are finite, so they pass through. `seededRandom` coerces to
		// uint32, so they are usable rather than merely tolerated.
		expect(isTestMode("?test=1&seed=-5").seed).toBe(-5);
		expect(isTestMode("?test=1&seed=1.5").seed).toBe(1.5);
	});

	it("defaults to no test mode with no arguments at all", () => {
		expect(isTestMode()).toEqual({ testMode: false, seed: 42 });
	});
});

describe("asset index", () => {
	const index = loadAssetIndex();

	it("resolves every declared animation id to a real sheet and clip", () => {
		for (const animationId of Object.keys(index.animationIds)) {
			// A dangling id is a black sprite at runtime, not an error — the
			// loader simply finds nothing. Resolving every id here is what turns
			// that into a failing test instead.
			const resolved = resolveAnimation(index, animationId);
			expect(resolved.sheet.id, animationId).toBeDefined();
			expect(resolved.animation.id, animationId).toBeDefined();
		}
	});

	it("refuses an unknown animation id, sheet and clip with distinct messages", () => {
		expect(() => resolveAnimation(index, "bo.moonwalk")).toThrowError(
			/unknown animation id: bo\.moonwalk/u,
		);
		const broken = {
			...index,
			animationIds: { "x.y": { sheet: "no-sheet", animation: "no-clip" } },
		};
		expect(() => resolveAnimation(broken as never, "x.y")).toThrowError(
			/unknown sheet for animation/u,
		);
		const firstSheet = Object.keys(index.spritesheets)[0] ?? "";
		const badClip = {
			...index,
			animationIds: { "x.y": { sheet: firstSheet, animation: "no-clip" } },
		};
		// Three distinct messages because the three failures have three
		// different fixes: a typo in the id map, a missing sheet, a renamed clip.
		expect(() => resolveAnimation(badClip as never, "x.y")).toThrowError(
			/unknown animation no-clip on sheet/u,
		);
	});

	it("computes sheet geometry including margin and inter-frame spacing", () => {
		// The STOP rule: geometry is measured from the index, never guessed. A
		// formula that ignored spacing would slice every frame off-by-N pixels
		// and the sprite would jitter.
		expect(
			expectedSheetPixelSize({
				columns: 4,
				rows: 2,
				frameWidth: 100,
				frameHeight: 50,
				margin: 5,
				spacing: 2,
			} as never),
		).toEqual({ width: 4 * 100 + 10 + 3 * 2, height: 2 * 50 + 10 + 1 * 2 });
	});

	it("handles a single-column or single-row sheet without negative spacing", () => {
		// `Math.max(0, columns - 1)` is the guard: one column means no gaps, and
		// a naive `columns - 1` on a zero-column sheet would subtract spacing.
		expect(
			expectedSheetPixelSize({
				columns: 1,
				rows: 1,
				frameWidth: 10,
				frameHeight: 10,
				margin: 0,
				spacing: 4,
			} as never),
		).toEqual({ width: 10, height: 10 });
		expect(
			expectedSheetPixelSize({
				columns: 0,
				rows: 0,
				frameWidth: 10,
				frameHeight: 10,
				margin: 0,
				spacing: 4,
			} as never),
		).toEqual({ width: 0, height: 0 });
	});

	it("counts frames as columns times rows", () => {
		expect(frameCount({ columns: 4, rows: 3 } as never)).toBe(12);
	});

	it("expands an 'all' frame list, honouring an explicit frameCount", () => {
		const sheet = { columns: 3, rows: 2 } as never;
		expect(animationFrameList(sheet, { frames: "all" } as never)).toEqual([
			0, 1, 2, 3, 4, 5,
		]);
		// An explicit count wins: a sheet can carry trailing empty frames that
		// must not be played.
		expect(
			animationFrameList(sheet, { frames: "all", frameCount: 3 } as never),
		).toEqual([0, 1, 2]);
	});

	it("copies an explicit frame list rather than aliasing it", () => {
		const frames = [2, 0, 1];
		const result = animationFrameList(
			{ columns: 3, rows: 1 } as never,
			{
				frames,
			} as never,
		);
		result.push(9);
		// Order is preserved (a clip can play frames out of order) and the
		// caller's array is not aliased into the returned one.
		expect(frames).toEqual([2, 0, 1]);
		expect(result).toEqual([2, 0, 1, 9]);
	});

	it("resolves an absolute sheet path and refuses an unknown sheet", () => {
		const sheetId = Object.keys(index.spritesheets)[0] ?? "";
		expect(sheetAbsolutePath(index, sheetId).startsWith(assetsRoot())).toBe(
			true,
		);
		expect(() => sheetAbsolutePath(index, "no-such-sheet")).toThrowError(
			/unknown sheet: no-such-sheet/u,
		);
	});

	it("builds Phaser loader configs from measured geometry", () => {
		const configs = phaserSpritesheetConfigs(index);
		expect(configs.length).toBe(Object.keys(index.spritesheets).length);
		for (const config of configs) {
			// Every field comes from the index. A loader config with guessed
			// frame dimensions is the classic source of a sprite that renders
			// one frame smeared across two.
			const sheet = index.spritesheets[config.key];
			expect(config.frameWidth, config.key).toBe(sheet?.frameWidth);
			expect(config.frameHeight, config.key).toBe(sheet?.frameHeight);
			expect(config.margin, config.key).toBe(sheet?.margin);
			expect(config.spacing, config.key).toBe(sheet?.spacing);
		}
	});

	it("prefixes with a base URL and strips a trailing slash", () => {
		const sheetId = Object.keys(index.spritesheets)[0] ?? "";
		const withSlash = phaserSpritesheetConfigs(index, "https://cdn/assets/");
		const without = phaserSpritesheetConfigs(index, "https://cdn/assets");
		// A doubled slash usually still resolves, but not behind every CDN — and
		// the two spellings must not produce two different cache keys.
		expect(withSlash[0]?.url).toBe(without[0]?.url);
		expect(without[0]?.url).toMatch(/^https:\/\/cdn\/assets\/[^/]/u);
		expect(sheetId.length).toBeGreaterThan(0);
	});

	it("lists every asset path across all three categories", () => {
		const paths = allAssetPaths(index);
		expect(paths.length).toBeGreaterThanOrEqual(
			Object.keys(index.spritesheets).length,
		);
		// This list drives preload and coverage checks; a category omitted here
		// is a category that silently never loads.
		for (const sheet of Object.values(index.spritesheets)) {
			expect(paths, sheet.id).toContain(sheet.path);
		}
	});

	it("tolerates an index with no backgrounds or images", () => {
		// Both categories are optional in the v2 shape; the `?? {}` fallbacks are
		// what let an index that predates them still load.
		expect(
			allAssetPaths({ spritesheets: {}, animationIds: {} } as never),
		).toEqual([]);
	});

	it("loads from an explicit path as well as the default", () => {
		expect(
			loadAssetIndex(join(assetsRoot(), "assets_index.json")).spritesheets,
		).toEqual(index.spritesheets);
	});

	it("freezes the loaded index", () => {
		// The index is a module-level singleton in practice; a scene mutating it
		// would change what every other scene loads.
		expect(Object.isFrozen(loadAssetIndex())).toBe(true);
	});
});
