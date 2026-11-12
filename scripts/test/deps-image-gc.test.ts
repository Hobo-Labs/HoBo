import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	depsGcKeepTag,
	selectWorkerImagesForDeletion,
	type WorkerImage,
} from "../../packages/ci-gh-actions/src/isolated-worker/image-gc.ts";

const current = "hobo-ci-deps:current";
const image = (tag: string, created: number, inUse = false): WorkerImage => ({
	id: tag,
	tag,
	created: new Date(created).toISOString(),
	inUse,
});

describe("deps image garbage collection", () => {
	it("maps hobo-ci-deps:local to the keyed tag when the label is known", () => {
		assert.equal(
			depsGcKeepTag("hobo-ci-deps:local", "abc12"),
			"hobo-ci-deps:abc12",
		);
		assert.equal(depsGcKeepTag("hobo-ci-deps:local", undefined), undefined);
		assert.equal(
			depsGcKeepTag("hobo-ci-deps:keyed", undefined),
			"hobo-ci-deps:keyed",
		);
	});

	it("keeps only the current and newest previous keyed images", () => {
		const images = [
			image("hobo-ci-deps:oldest", 200),
			image(current, 100),
			image("hobo-ci-deps:previous", 400),
			image("hobo-ci-deps:older", 300),
			image("hobo-ci-deps:local", 50),
		];
		assert.deepEqual(selectWorkerImagesForDeletion(images, current), [
			"hobo-ci-deps:older",
			"hobo-ci-deps:oldest",
		]);
	});

	it("never deletes local, current, or images used by running containers", () => {
		const images = [
			image(current, 500),
			image("hobo-ci-deps:previous", 400),
			image("hobo-ci-deps:running", 100, true),
			image("hobo-ci-deps:local", 50),
			image("hobo-ci-deps:expired", 200),
		];
		assert.deepEqual(selectWorkerImagesForDeletion(images, current), [
			"hobo-ci-deps:expired",
		]);
	});

	it("deletes every unused fetch intermediate and ignores unrelated images", () => {
		const images = [
			image(current, 500),
			image("hobo-ci-deps:previous", 400),
			image("hobo-ci-deps-fetch:new", 450),
			image("hobo-ci-deps-fetch:old", 100),
			image("hobo-ci-deps-fetch:running", 200, true),
			image("ghcr.io/hobo-labs/hobo/hobo-ci-deps:old", 100),
			image("hobo-ci-worker:old", 100),
		];
		assert.deepEqual(selectWorkerImagesForDeletion(images, current), [
			"hobo-ci-deps-fetch:new",
			"hobo-ci-deps-fetch:old",
		]);
	});
});
