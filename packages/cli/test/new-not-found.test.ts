/**
 * `isNotFound`: whether a caught value is a filesystem ENOENT, the ordinary
 * case of `hobo new` writing into a directory that does not exist yet.
 *
 * It reads `code` from any object, as it did before it was retyped: an Error
 * from another realm (a vm context, a worker's structured clone) is not an
 * `instanceof Error` here, and a library may throw a plain `{ code }` object.
 * Either one answered "something else", so `hobo new` rethrew the ordinary
 * case as an internal error.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { isNotFound } from "../src/commands/new.js";

describe("isNotFound", () => {
	it("recognises ENOENT on an Error from this realm", () => {
		expect(
			isNotFound(Object.assign(new Error("gone"), { code: "ENOENT" })),
		).toBe(true);
	});

	it("recognises ENOENT on an Error from another realm", () => {
		const foreign = runInNewContext(
			'Object.assign(new Error("gone"), { code: "ENOENT" })',
		);
		expect(foreign instanceof Error).toBe(false);
		expect(isNotFound(foreign)).toBe(true);
	});

	it("recognises ENOENT on a plain thrown object", () => {
		expect(isNotFound({ code: "ENOENT" })).toBe(true);
	});

	it("answers false for every other failure", () => {
		for (const other of [
			Object.assign(new Error("denied"), { code: "EACCES" }),
			new Error("no code"),
			{ code: "EEXIST" },
			"ENOENT",
			null,
			undefined,
			0,
		]) {
			expect(isNotFound(other)).toBe(false);
		}
	});
});
