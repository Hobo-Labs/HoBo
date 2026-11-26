/**
 * What an asset pin means on a machine: the cache location, the variable that
 * overrides a pin, and the reader of a release's SHA256SUMS.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cacheDir, overrideEnv, parseSums } from "../lib/pins-assets.ts";

const DIGEST = "a".repeat(64);

describe("cacheDir and overrideEnv", () => {
	it("follows XDG_CACHE_HOME when it is absolute, else ~/.cache", () => {
		assert.equal(cacheDir({ XDG_CACHE_HOME: "/x/cache" }), "/x/cache/siblings");
		assert.equal(cacheDir({ HOME: "/h" }), "/h/.cache/siblings");
		assert.equal(
			cacheDir({ XDG_CACHE_HOME: "relative", HOME: "/h" }),
			"/h/.cache/siblings",
		);
	});

	it("names the environment override of each asset", () => {
		assert.equal(overrideEnv("mirror"), "MIRROR_BIN");
		assert.equal(overrideEnv("opensesame-kit"), "HOBO_OPENSESAME_KIT");
		assert.equal(overrideEnv("some-tool"), "HOBO_SOME_TOOL");
	});
});

describe("parseSums", () => {
	it("reads sha256sum lines, text and binary markers, comments and blanks", () => {
		const sums = parseSums(
			`# release\n${DIGEST}  mirror-linux-x64\n\n${"b".repeat(64)} *kit.tgz\n`,
		);
		assert.equal(sums.get("mirror-linux-x64"), DIGEST);
		assert.equal(sums.get("kit.tgz"), "b".repeat(64));
	});

	it("refuses a file name listed twice, with or without the binary marker", () => {
		assert.throws(
			() => parseSums(`${DIGEST}  tool\n${"b".repeat(64)}  tool\n`),
			/SUMS_MALFORMED/,
		);
		assert.throws(
			() => parseSums(`${DIGEST}  tool\n${DIGEST} *tool\n`),
			/SUMS_MALFORMED/,
		);
	});

	it("refuses an upper-case digest, which no lower-case pin could ever match", () => {
		assert.throws(
			() => parseSums(`${DIGEST.toUpperCase()}  tool\n`),
			/SUMS_MALFORMED/,
		);
	});

	it("refuses a name with anything after it, a trailing space, a control character or a leading dot", () => {
		for (const bad of [
			"tool extra fields",
			"tool ",
			"to\u0000ol",
			"to\rol",
			"to\u0001ol",
			".hidden",
			"..",
			"a/b",
			"a\\b",
		]) {
			assert.throws(
				() => parseSums(`${DIGEST}  ${bad}\n`),
				/SUMS_MALFORMED/,
				JSON.stringify(bad),
			);
		}
	});

	it("accepts CRLF line endings and the names a release really has", () => {
		const sums = parseSums(
			`${DIGEST}  mirror-linux-x64\r\n${DIGEST} *kit_1.2.3+build@x.tgz\r\n`,
		);
		assert.deepEqual(
			[...sums.keys()],
			["mirror-linux-x64", "kit_1.2.3+build@x.tgz"],
		);
	});

	it("refuses a malformed line and a path", () => {
		assert.throws(() => parseSums("nonsense\n"), /SUMS_MALFORMED/);
		assert.throws(() => parseSums(`${DIGEST}  ../escape\n`), /SUMS_MALFORMED/);
	});
});
