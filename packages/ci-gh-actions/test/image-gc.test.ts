import { describe, expect, it } from "vitest";
import {
	selectWorkerImagesForDeletion,
	selectWorkerImageTagsForDeletion,
	type WorkerImage,
} from "../src/isolated-worker/image-gc.js";

function image(
	tag: string,
	created: string,
	inUse = false,
	id = tag,
): WorkerImage {
	return { id, tag, created, inUse };
}

describe("worker image garbage collection", () => {
	it("keeps local, in-use, and two newest deps images while pruning fetch intermediates", () => {
		const images = [
			image("hobo-ci-deps:old", "2026-01-01T00:00:00Z"),
			image("hobo-ci-deps:newest", "2026-04-01T00:00:00Z"),
			image("hobo-ci-deps:local", "2025-01-01T00:00:00Z"),
			image("hobo-ci-deps:busy", "2025-06-01T00:00:00Z", true),
			image("hobo-ci-deps:middle", "2026-02-01T00:00:00Z"),
			image("hobo-ci-deps:newer", "2026-03-01T00:00:00Z"),
			image("hobo-ci-deps-fetch:first", "2026-01-01T00:00:00Z"),
			image("hobo-ci-deps-fetch:second", "2026-02-01T00:00:00Z"),
			image("hobo-ci-deps-fetch:busy", "2026-03-01T00:00:00Z", true),
			image("node:24", "2025-01-01T00:00:00Z"),
		];

		expect(selectWorkerImagesForDeletion(images)).toEqual([
			"hobo-ci-deps-fetch:first",
			"hobo-ci-deps-fetch:second",
			"hobo-ci-deps:middle",
			"hobo-ci-deps:old",
		]);
	});

	it("uses tags to break created timestamp ties deterministically", () => {
		const created = "2026-01-01T00:00:00Z";
		const images = [
			image("hobo-ci-deps:delta", created),
			image("hobo-ci-deps:bravo", created),
			image("hobo-ci-deps:charlie", created),
			image("hobo-ci-deps:alpha", created),
		];

		expect(selectWorkerImagesForDeletion(images)).toEqual([
			"hobo-ci-deps:charlie",
			"hobo-ci-deps:delta",
		]);
		expect(selectWorkerImagesForDeletion([...images].reverse())).toEqual([
			"hobo-ci-deps:charlie",
			"hobo-ci-deps:delta",
		]);
	});

	it("keeps the current and previous worker versions plus local and running images", () => {
		const images = [
			image("hobo-ci-worker:v000000000001", "2026-01-02T00:00:00Z"),
			image("hobo-ci-worker:v000000000002", "2026-01-03T00:00:00Z"),
			image(
				"hobo-ci-worker:v000000000003",
				"2026-01-04T00:00:00Z",
				false,
				"current",
			),
			image("hobo-ci-worker:local", "2026-01-04T00:00:00Z", false, "current"),
			image("hobo-ci-worker:v000000000000", "2026-01-01T00:00:00Z", true),
		];

		expect(selectWorkerImageTagsForDeletion(images, "v000000000003")).toEqual([
			"hobo-ci-worker:v000000000001",
		]);
	});

	it("infers the current worker version from the image behind local during daemon GC", () => {
		const images = [
			image("hobo-ci-worker:v000000000001", "2026-01-01T00:00:00Z"),
			image("hobo-ci-worker:v000000000002", "2026-01-02T00:00:00Z"),
			image(
				"hobo-ci-worker:v000000000003",
				"2026-01-03T00:00:00Z",
				false,
				"current",
			),
			image("hobo-ci-worker:local", "2026-01-03T00:00:00Z", false, "current"),
		];

		expect(selectWorkerImageTagsForDeletion(images)).toEqual([
			"hobo-ci-worker:v000000000001",
		]);
		expect(selectWorkerImagesForDeletion(images)).toEqual([
			"hobo-ci-worker:v000000000001",
		]);
	});

	it("retains two versions when no current worker image can be identified", () => {
		const images = [
			image("hobo-ci-worker:v000000000001", "2026-01-01T00:00:00Z"),
			image("hobo-ci-worker:v000000000002", "2026-01-02T00:00:00Z"),
			image("hobo-ci-worker:v000000000003", "2026-01-03T00:00:00Z"),
		];

		expect(selectWorkerImageTagsForDeletion(images)).toEqual([
			"hobo-ci-worker:v000000000001",
		]);
	});
});
