// The runtime package has no driver. This is enforced here, not by
// convention: the driver and its BSON library are devDependencies, and
// nothing under src/ may import them.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { MongoDataError, parseChangeReadRequest } from "../src/index.js";

const SRC = new URL("../src/", import.meta.url);
const PACKAGE = new URL("../package.json", import.meta.url);

describe("the runtime imports no driver", () => {
	test("nothing under src/ imports mongodb or bson", () => {
		const offenders = readdirSync(SRC)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) =>
				/from\s+["'](mongodb|bson)(\/[^"']*)?["']|require\(\s*["'](mongodb|bson)/u.test(
					readFileSync(new URL(name, SRC), "utf8"),
				),
			);
		assert.deepEqual(offenders, []);
	});

	test("the driver is a devDependency only", () => {
		const manifest = JSON.parse(readFileSync(PACKAGE, "utf8"));
		assert.equal(manifest.dependencies.mongodb, undefined);
		assert.equal(manifest.dependencies.bson, undefined);
		assert.deepEqual(Object.keys(manifest.dependencies), ["@hobo/data-core"]);
		assert.ok(manifest.devDependencies.mongodb);
	});
});

describe("a wire request cannot smuggle an operator or a system collection", () => {
	const base = { collection: "orders", after: "token", limit: 1 };

	test("collection names and key paths are checked", () => {
		assert.deepEqual(
			parseChangeReadRequest({
				...base,
				where: { path: "_id.t", equals: "tenant-a" },
			}).where,
			{ path: "_id.t", equals: "tenant-a" },
		);
		for (const bad of [
			{ ...base, collection: "system.users" },
			{ ...base, collection: "a$b" },
			{ ...base, collection: "Orders" },
			{ ...base, where: { path: "$where", equals: "x" } },
			{ ...base, where: { path: "_id..t", equals: "x" } },
			{ ...base, where: { path: "_id.t" } },
			{ ...base, after: "" },
		]) {
			assert.throws(
				() => parseChangeReadRequest(bad),
				(cause) =>
					cause instanceof MongoDataError &&
					cause.code === "MONGODB_INVALID_REQUEST",
			);
		}
	});
});
