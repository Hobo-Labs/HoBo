import { describe, expect, it } from "vitest";
import {
	RELEASE_IMAGE_GC_GRACE_MS,
	selectReleaseImageTagsForDeletion,
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

	const RELEASE_NOW = Date.parse("2026-06-01T00:00:00Z");

	it("removes superseded GHCR release tags and never a candidate tag", () => {
		const images = [
			image("hobo-cli:candidate", "2026-01-01T00:00:00Z"),
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.1",
				"2026-01-02T00:00:00Z",
			),
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.2",
				"2026-03-01T00:00:00Z",
			),
			image("hobo-code:candidate", "2026-02-01T00:00:00Z", true),
		];
		expect(
			selectReleaseImageTagsForDeletion(images, { nowMs: RELEASE_NOW }),
		).toEqual(["ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.1"]);
	});

	it("keeps a candidate and the GHCR tags of the image it names", () => {
		// push-release-ghcr-images tags `<id>:candidate` for GHCR, then pushes.
		const images = [
			image("hobo-cli:candidate", "2026-02-01T00:00:00Z", false, "sha256:new"),
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.2",
				"2026-02-01T00:00:00Z",
				false,
				"sha256:new",
			),
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:latest",
				"2026-02-01T00:00:00Z",
				false,
				"sha256:new",
			),
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.3",
				"2026-03-01T00:00:00Z",
				false,
				"sha256:newer",
			),
		];
		expect(
			selectReleaseImageTagsForDeletion(images, { nowMs: RELEASE_NOW }),
		).toEqual([]);
		expect(
			selectWorkerImagesForDeletion(images, undefined, { nowMs: RELEASE_NOW }),
		).toEqual([]);
	});

	it("keeps a release image a running container uses, under every tag", () => {
		const images = [
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.1",
				"2026-01-01T00:00:00Z",
				true,
				"sha256:busy",
			),
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:previous",
				"2026-01-01T00:00:00Z",
				false,
				"sha256:busy",
			),
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.2",
				"2026-02-01T00:00:00Z",
			),
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.3",
				"2026-03-01T00:00:00Z",
			),
		];
		expect(
			selectReleaseImageTagsForDeletion(images, { nowMs: RELEASE_NOW }),
		).toEqual(["ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.2"]);
	});

	it("keeps a superseded release image until the grace has passed", () => {
		const images = [
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.1",
				"2026-05-31T23:30:00Z",
			),
			image(
				"ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.2",
				"2026-05-31T23:45:00Z",
			),
			image("ghcr.io/hobo-labs/hobo/hobo-cli:undated", "not a date"),
		];
		expect(
			selectReleaseImageTagsForDeletion(images, { nowMs: RELEASE_NOW }),
		).toEqual([]);
		expect(
			selectReleaseImageTagsForDeletion(images, {
				nowMs: RELEASE_NOW + RELEASE_IMAGE_GC_GRACE_MS,
			}),
		).toEqual(["ghcr.io/hobo-labs/hobo/hobo-cli:0.0.0-alpha.1"]);
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
