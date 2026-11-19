import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { loadAssetIndex } from "../src/assets-index.js";

type FrameQueue = { callback?: (time: number) => void };
type AnimationTestWindow = {
	__TEST__?: { commands: { showAnim: (id: string) => void } };
	addEventListener: () => void;
};

class ImageStub {
	src = "";
	decode() {
		return Promise.resolve();
	}
}

it("draws each measured animation frame entirely within the canvas", async () => {
	const root = resolve(import.meta.dirname, "..");
	const index = loadAssetIndex(resolve(root, "assets/assets_index.json"));
	const drawn: Array<{ x: number; y: number; width: number; height: number }> =
		[];
	const context = {
		clearRect() {},
		fillRect() {},
		beginPath() {},
		moveTo() {},
		lineTo() {},
		stroke() {},
		drawImage(
			_image: ImageStub,
			_sx: number,
			_sy: number,
			_sw: number,
			_sh: number,
			x: number,
			y: number,
			width: number,
			height: number,
		) {
			drawn.push({ x, y, width, height });
		},
	};
	const canvas = { width: 640, height: 480, getContext: () => context };
	const frame: FrameQueue = {};
	const windowStub: AnimationTestWindow = { addEventListener() {} };
	runInNewContext(readFileSync(resolve(root, "public/anim-test.js"), "utf8"), {
		window: windowStub,
		document: {
			body: { dataset: {} },
			getElementById: (id: string) => (id === "c" ? canvas : {}),
			querySelectorAll: () => [],
		},
		performance: { now: () => 0 },
		Image: ImageStub,
		fetch: () => Promise.resolve({ json: () => Promise.resolve(index) }),
		requestAnimationFrame: (callback: (time: number) => void) => {
			frame.callback = callback;
		},
	});
	await new Promise<void>((done) => setImmediate(done));
	const seam = windowStub.__TEST__;
	if (!seam) throw new Error("animation test seam did not initialize");
	for (const id of Object.keys(index.animationIds)) {
		seam.commands.showAnim(id);
		if (!frame.callback) throw new Error("animation frame was not requested");
		frame.callback(100);
		const bounds = drawn.pop();
		if (!bounds) throw new Error(`no frame drawn for ${id}`);
		expect(bounds.x, id).toBeGreaterThanOrEqual(0);
		expect(bounds.y, id).toBeGreaterThanOrEqual(0);
		expect(bounds.x + bounds.width, id).toBeLessThanOrEqual(canvas.width);
		expect(bounds.y + bounds.height, id).toBeLessThanOrEqual(canvas.height);
	}
});
