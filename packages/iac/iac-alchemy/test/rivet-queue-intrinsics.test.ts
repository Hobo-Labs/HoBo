import { expect, it } from "vitest";
import { runPublishedAdapterFixture } from "./published-adapter-fixture.js";

it("does not turn a denied queue dispatch into success when host code poisons the realm", {
	timeout: 150_000,
}, () => {
	const output = runPublishedAdapterFixture(
		new URL("./rivet-queue-intrinsics-fixture.mjs", import.meta.url),
		"rivet-queue.js",
	);
	expect(output).toContain("queue-intrinsics-ok");
});
