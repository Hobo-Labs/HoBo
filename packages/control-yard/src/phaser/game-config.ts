import { YARD_HEIGHT, YARD_WIDTH } from "../layout.js";

export type YardGameConfigOptions = Readonly<{
	parent?: string | HTMLElement;
	testMode?: boolean;
	backgroundColor?: string;
}>;

export function yardPhaserConfig(
	opts: YardGameConfigOptions = {},
): Record<string, unknown> {
	return {
		type: 0,
		width: YARD_WIDTH,
		height: YARD_HEIGHT,
		parent: opts.parent ?? "yard-root",
		backgroundColor: opts.backgroundColor ?? "#cfe0ec",
		scale: {
			mode: 3,
			autoCenter: 1,
		},
		physics: { default: false },
		fps: opts.testMode
			? { target: 60, forceSetTimeOut: true, smoothStep: false }
			: { target: 60, smoothStep: true },
		render: {
			pixelArt: true,
			antialias: false,
			roundPixels: true,
		},
	};
}
