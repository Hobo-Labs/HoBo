/**
 * BootScene — central asset load from measured asset index.
 * phaser-gamedev: load in preload only; never guess frame sizes.
 */
import type { AssetIndex } from "../assets-index.js";
import {
	animationFrameList,
	phaserSpritesheetConfigs,
	resolveAnimation,
} from "../assets-index.js";

export type BootSceneDeps = {
	index: AssetIndex;
	assetBaseUrl: string;
};

/** Pure preload plan — unit-testable without Phaser. */
export function buildBootLoadPlan(
	index: AssetIndex,
	assetBaseUrl: string,
): {
	spritesheets: ReturnType<typeof phaserSpritesheetConfigs>;
	images: { key: string; url: string }[];
	backgrounds: { key: string; url: string }[];
	animations: {
		key: string;
		sheetKey: string;
		frames: number[];
		frameRate: number;
		repeat: number;
	}[];
} {
	const base = assetBaseUrl.replace(/\/$/, "");
	const url = (p: string) => (base ? `${base}/${p}` : p);

	const images = Object.entries(index.images ?? {}).map(([key, img]) => ({
		key,
		url: url(img.path),
	}));
	const backgrounds = Object.entries(index.backgrounds ?? {}).map(
		([key, img]) => ({
			key: `bg-${key}`,
			url: url(img.path),
		}),
	);
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

	return {
		spritesheets: phaserSpritesheetConfigs(index, assetBaseUrl),
		images,
		backgrounds,
		animations,
	};
}
