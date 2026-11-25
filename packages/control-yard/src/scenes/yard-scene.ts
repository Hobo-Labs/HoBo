/**
 * Phaser Yard scene contract + pure bootstrap helpers.
 *
 * Browser hosts that load Phaser 3 call `describeYardSceneLoad` to register
 * spritesheets from the asset index (measure-before-load STOP rule already
 * enforced by assets:validate). Clip names always resolve via stable animation ids.
 */

import {
	type AssetIndex,
	animationFrameList,
	loadAssetIndex,
	resolveAnimation,
	type SpritesheetDef,
	sheetAbsolutePath,
} from "../assets-index.js";
import type { YardVisualState } from "../entity-state.js";
import { YARD_LAYOUT } from "../layout.js";

export type PhaserLikeLoader = {
	spritesheet: (
		key: string,
		url: string,
		config: {
			frameWidth: number;
			frameHeight: number;
			margin?: number;
			spacing?: number;
		},
	) => void;
	image: (key: string, url: string) => void;
};

export type PhaserLikeAnims = {
	create: (config: {
		key: string;
		frames: { key: string; frame: number }[];
		frameRate: number;
		repeat: number;
	}) => void;
	exists?: (key: string) => boolean;
};

export type YardLoadManifest = Readonly<{
	sheets: readonly {
		key: string;
		url: string;
		frameWidth: number;
		frameHeight: number;
		margin: number;
		spacing: number;
	}[];
	images: readonly { key: string; url: string }[];
	animations: readonly {
		key: string;
		sheetKey: string;
		frames: number[];
		frameRate: number;
		repeat: number;
	}[];
}>;

/** Build load manifest from asset index — only path into Phaser loaders. */
export function describeYardSceneLoad(
	index: AssetIndex = loadAssetIndex(),
	assetBaseUrl = "",
): YardLoadManifest {
	const base = assetBaseUrl.replace(/\/$/, "");
	const url = (p: string) => (base ? `${base}/${p}` : joinAsset(index, p));

	const sheets = Object.values(index.spritesheets).map((sheet) => ({
		key: sheet.id,
		url: url(sheet.path),
		frameWidth: sheet.frameWidth,
		frameHeight: sheet.frameHeight,
		margin: sheet.margin,
		spacing: sheet.spacing,
	}));

	const images = [
		...Object.entries(index.images ?? {}).map(([key, img]) => ({
			key,
			url: url(img.path),
		})),
		...Object.entries(index.backgrounds ?? {}).map(([key, img]) => ({
			key: `bg-${key}`,
			url: url(img.path),
		})),
	];

	const animations = Object.entries(index.animationIds).map(([animId]) => {
		const { sheet, animation } = resolveAnimation(index, animId);
		return {
			key: animation.id,
			sheetKey: sheet.id,
			frames: animationFrameList(sheet, animation),
			frameRate: animation.frameRate ?? animation.fps ?? 10,
			repeat: animation.repeat,
		};
	});

	return Object.freeze({
		sheets: Object.freeze(sheets),
		images: Object.freeze(images),
		animations: Object.freeze(animations),
	});
}

function joinAsset(index: AssetIndex, rel: string): string {
	// Prefer absolute package assets path for node; browser uses assetBaseUrl.
	try {
		return sheetAbsolutePath(index, "bo-idle").replace(
			/bo\/bo-idle\.png$/,
			rel,
		);
	} catch {
		return rel;
	}
}

export function applyLoadManifest(
	loader: PhaserLikeLoader,
	manifest: YardLoadManifest,
): void {
	for (const s of manifest.sheets) {
		// STOP rule: frame sizes come from measured asset index only.
		loader.spritesheet(s.key, s.url, {
			frameWidth: s.frameWidth,
			frameHeight: s.frameHeight,
			margin: s.margin,
			spacing: s.spacing,
		});
	}
	for (const img of manifest.images) {
		loader.image(img.key, img.url);
	}
}

export function registerAnimations(
	anims: PhaserLikeAnims,
	manifest: YardLoadManifest,
): void {
	for (const a of manifest.animations) {
		if (anims.exists?.(a.key)) continue;
		anims.create({
			key: a.key,
			frames: a.frames.map((frame) => ({ key: a.sheetKey, frame })),
			frameRate: a.frameRate,
			repeat: a.repeat,
		});
	}
}

export type YardSceneHud = Readonly<{
	zoneLabels: readonly { id: string; label: string; x: number; y: number }[];
	costMeter: { x: number; y: number; width: number; height: number };
	width: number;
	height: number;
}>;

export function yardSceneHud(): YardSceneHud {
	return Object.freeze({
		width: YARD_LAYOUT.width,
		height: YARD_LAYOUT.height,
		costMeter: YARD_LAYOUT.costMeter,
		zoneLabels: Object.freeze(
			Object.values(YARD_LAYOUT.zones).map((z) =>
				Object.freeze({
					id: z.id,
					label: z.label,
					x: z.x,
					y: z.y,
				}),
			),
		),
	});
}

/** Map visual state → which animation id Bo should play (stable id). */
export function boAnimationForVisual(visual: YardVisualState): string {
	return visual.bo.animationId;
}

export function assertSheetFitsFrames(sheet: SpritesheetDef): void {
	const frames = sheet.columns * sheet.rows;
	if (frames <= 0) throw new Error(`sheet ${sheet.id} has no frames`);
	for (const anim of Object.values(sheet.animations)) {
		if (anim.frames === "all") continue;
		for (const f of anim.frames) {
			if (f < 0 || f >= frames) {
				throw new Error(
					`sheet ${sheet.id} animation ${anim.id} frame ${f} out of bounds (0..${frames - 1})`,
				);
			}
		}
	}
}
