import type { YardTestSeam } from "../src/test-seam.js";

type AnimationTestSeam = {
	ready: boolean;
	frameCount: number;
	animId: string;
	state: () => { animId: string };
	commands: { showAnim: (id: string) => void };
};

declare global {
	interface Window {
		__TEST__?: YardTestSeam | AnimationTestSeam;
	}
}

/**
 * Runs inside the page via Playwright's `evaluate`, so it must be self-contained:
 * the browser cannot see imported helpers or other Node-side bindings.
 */
export function sampleBoInk() {
	const canvas = document.querySelector<HTMLCanvasElement>("canvas#yard");
	if (!canvas) throw new Error("yard canvas is missing");
	const context = canvas.getContext("2d");
	if (!context) throw new Error("yard canvas has no 2d context");
	const seam = window.__TEST__;
	if (!seam || !("sceneKey" in seam))
		throw new Error("yard test seam is missing");
	const { bo } = seam.state();
	const x0 = Math.max(0, bo.x - 50);
	const y0 = Math.max(0, bo.y - 120);
	const data = context.getImageData(x0, y0, 100, 130).data;
	let dark = 0;
	for (let i = 0; i < data.length; i += 4) {
		const red = data[i];
		const green = data[i + 1];
		const blue = data[i + 2];
		if (red === undefined || green === undefined || blue === undefined) {
			throw new Error("incomplete canvas pixel");
		}
		if (red + green + blue < 90) dark++;
	}
	return { dark, bo };
}
