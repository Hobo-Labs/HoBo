import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AnimationDef = Readonly<{
	id: string;
	sourceClipName: string;
	frames: number[] | "all";
	frameCount?: number;
	fps?: number;
	frameRate: number;
	repeat: number;
}>;

export type SpritesheetDef = Readonly<{
	id: string;
	path: string;
	width?: number;
	height?: number;
	frameWidth: number;
	frameHeight: number;
	columns: number;
	rows: number;
	margin: number;
	spacing: number;
	fps?: number;
	frameMs?: number;
	origin: { x: number; y: number };
	anchor?: string;
	neverMirrorFrom?: string;
	frames?: number[][] | "all" | number[];
	emptyCount?: number;
	animations: Readonly<Record<string, AnimationDef>>;
}>;

export type ImageDef = Readonly<{
	path: string;
	width: number;
	height: number;
	id?: string;
}>;

export type AssetIndex = Readonly<{
	meta?: Readonly<{
		version?: number;
		root?: string;
		defaultFps?: number;
		measuredAt?: string;
		artBible?: string;
		notes?: readonly string[];
	}>;
	/** gamedev-assets v2 categories */
	backgrounds?: Readonly<Record<string, ImageDef>>;
	images?: Readonly<Record<string, ImageDef>>;
	spritesheets: Readonly<Record<string, SpritesheetDef>>;
	animationIds: Readonly<Record<string, { sheet: string; animation: string }>>;
	zoneAssetKeys?: Readonly<Record<string, string>>;
}>;

const HERE = dirname(fileURLToPath(import.meta.url));

export function assetsRoot(): string {
	return join(HERE, "..", "assets");
}

export function loadAssetIndex(indexPath?: string): AssetIndex {
	const path = indexPath ?? join(assetsRoot(), "assets_index.json");
	const raw = JSON.parse(readFileSync(path, "utf8")) as AssetIndex;
	return Object.freeze(raw);
}

/** Resolve stable animation id → sheet + clip metadata. Never hard-code clip names. */
export function resolveAnimation(
	index: AssetIndex,
	animationId: string,
): { sheet: SpritesheetDef; animation: AnimationDef } {
	const ref = index.animationIds[animationId];
	if (!ref) throw new Error(`unknown animation id: ${animationId}`);
	const sheet = index.spritesheets[ref.sheet];
	if (!sheet) {
		throw new Error(`unknown sheet for animation ${animationId}: ${ref.sheet}`);
	}
	const animation = sheet.animations[ref.animation];
	if (!animation) {
		throw new Error(`unknown animation ${ref.animation} on sheet ${ref.sheet}`);
	}
	return { sheet, animation };
}

export function sheetAbsolutePath(
	index: AssetIndex,
	sheetId: string,
	root = assetsRoot(),
): string {
	const sheet = index.spritesheets[sheetId];
	if (!sheet) throw new Error(`unknown sheet: ${sheetId}`);
	return join(root, sheet.path);
}

export function expectedSheetPixelSize(sheet: SpritesheetDef): {
	width: number;
	height: number;
} {
	const width =
		sheet.columns * sheet.frameWidth +
		sheet.margin * 2 +
		sheet.spacing * Math.max(0, sheet.columns - 1);
	const height =
		sheet.rows * sheet.frameHeight +
		sheet.margin * 2 +
		sheet.spacing * Math.max(0, sheet.rows - 1);
	return { width, height };
}

export function frameCount(sheet: SpritesheetDef): number {
	return sheet.columns * sheet.rows;
}

export function animationFrameList(
	sheet: SpritesheetDef,
	animation: AnimationDef,
): number[] {
	if (animation.frames === "all") {
		const n = animation.frameCount ?? frameCount(sheet);
		return Array.from({ length: n }, (_, i) => i);
	}
	return [...animation.frames];
}

/** Phaser loader configs measured from index (STOP rule). */
export function phaserSpritesheetConfigs(
	index: AssetIndex,
	assetBaseUrl = "",
): readonly {
	key: string;
	url: string;
	frameWidth: number;
	frameHeight: number;
	margin: number;
	spacing: number;
}[] {
	return Object.values(index.spritesheets).map((sheet) => ({
		key: sheet.id,
		url: assetBaseUrl
			? `${assetBaseUrl.replace(/\/$/, "")}/${sheet.path}`
			: sheetAbsolutePath(index, sheet.id),
		frameWidth: sheet.frameWidth,
		frameHeight: sheet.frameHeight,
		margin: sheet.margin,
		spacing: sheet.spacing,
	}));
}

/** All PNG paths for coverage / preload. */
export function allAssetPaths(index: AssetIndex): string[] {
	const paths: string[] = [];
	for (const b of Object.values(index.backgrounds ?? {})) paths.push(b.path);
	for (const i of Object.values(index.images ?? {})) paths.push(i.path);
	for (const s of Object.values(index.spritesheets)) paths.push(s.path);
	return paths;
}
