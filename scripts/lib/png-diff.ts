import { readFileSync, writeFileSync } from "node:fs";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export type PngDiffResult =
	| { readonly comparable: false; readonly detail: string }
	| { readonly comparable: true; readonly rms: number };

export function comparePngFiles(
	expectedPath: string,
	actualPath: string,
	diffPath: string,
): PngDiffResult {
	const expected = PNG.sync.read(readFileSync(expectedPath));
	const actual = PNG.sync.read(readFileSync(actualPath));
	if (expected.width !== actual.width || expected.height !== actual.height) {
		return {
			comparable: false,
			detail: `${expected.width}x${expected.height} != ${actual.width}x${actual.height}`,
		};
	}
	const diff = new PNG({ width: expected.width, height: expected.height });
	pixelmatch(
		expected.data,
		actual.data,
		diff.data,
		expected.width,
		expected.height,
		{
			threshold: 0.1,
		},
	);
	writeFileSync(diffPath, PNG.sync.write(diff));
	let squaredError = 0;
	for (let offset = 0; offset < expected.data.length; offset += 4) {
		for (let channel = 0; channel < 3; channel += 1) {
			const delta =
				(expected.data[offset + channel] ?? 0) -
				(actual.data[offset + channel] ?? 0);
			squaredError += delta * delta;
		}
	}
	return {
		comparable: true,
		rms: Math.sqrt(squaredError / (expected.width * expected.height * 3)),
	};
}
