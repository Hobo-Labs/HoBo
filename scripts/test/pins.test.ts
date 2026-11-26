/**
 * The pin manifest (`tools/pins/siblings.json`) and what an asset pin means on
 * a machine.
 *
 * The parser is the only door untrusted text uses: after `parsePins` returns,
 * every URL is https (or a loopback http URL a test asked for), every digest
 * is 64 lowercase hex characters and every path stays inside the repository,
 * so nothing downstream re-checks them. The verified fetch has its own file,
 * `pins-fetch.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	type AssetPin,
	isSafeRef,
	type JsonObject,
	type Pins,
	PinsError,
	parsePins,
} from "../lib/pins.ts";
import {
	assetFor,
	currentTarget,
	releaseBase,
	serializePins,
} from "../lib/pins-assets.ts";
import { REPO_ROOT } from "./support/pins-support.ts";

const DIGEST = "a".repeat(64);

function manifest(overrides: JsonObject = {}): string {
	return JSON.stringify({
		schemaVersion: 1,
		git: {
			"ts-autocode": {
				path: "external/ts-autocode",
				repo: "https://github.com/Tyler-R-Kendrick/ts-autocode.git",
				branch: "main",
				sparse: null,
			},
		},
		assets: { mirror: null },
		vendor: {},
		...overrides,
	});
}

function assetManifest(file: JsonObject): string {
	return manifest({
		assets: {
			mirror: {
				repo: "https://github.com/example/mirror",
				tag: "v1.0.0",
				files: {
					"linux-x64": {
						url: "https://example.com/mirror-linux-x64",
						sha256: DIGEST,
						size: 10,
						entry: "mirror",
						...file,
					},
				},
			},
		},
	});
}

function refusal(text: string, options = {}): PinsError {
	try {
		parsePins(text, options);
	} catch (error) {
		assert.ok(
			error instanceof PinsError,
			`expected PinsError, got ${String(error)}`,
		);
		return error;
	}
	assert.fail("parsePins accepted a manifest it must refuse");
}

describe("parsePins", () => {
	it("parses the committed tools/pins/siblings.json", () => {
		const pins = parsePins(
			readFileSync(join(REPO_ROOT, "tools/pins/siblings.json"), "utf8"),
		);
		assert.equal(pins.git["ts-autocode"]?.path, "external/ts-autocode");
		assert.equal(pins.assets.mirror, null);
		assert.equal(pins.assets["opensesame-kit"], null);
		assert.equal(pins.vendor["anti-slop"]?.dest, "tools/oxlint/anti-slop");
	});

	it("the committed manifest is in canonical form, so a bump changes only what it means to", () => {
		const text = readFileSync(
			join(REPO_ROOT, "tools/pins/siblings.json"),
			"utf8",
		);
		assert.equal(serializePins(parsePins(text)), text);
	});

	it("rejects an asset whose sha256 is not 64 hex characters", () => {
		for (const bad of ["abc", "A".repeat(64), "g".repeat(64), `${DIGEST}0`]) {
			const error = refusal(assetManifest({ sha256: bad }));
			assert.equal(error.code, "PINS_MALFORMED");
			assert.match(error.message, /sha256/);
		}
	});

	it("rejects an http:// url", () => {
		const error = refusal(assetManifest({ url: "http://example.com/mirror" }));
		assert.equal(error.code, "PINS_MALFORMED");
		assert.match(error.message, /https/);
	});

	it("accepts a loopback http url only when the caller allows local sources", () => {
		const text = assetManifest({ url: "http://127.0.0.1:9/mirror" });
		refusal(text);
		assert.doesNotThrow(() => parsePins(text, { allowLocal: true }));
	});

	it("still rejects http to a non-loopback host when local sources are allowed", () => {
		const text = assetManifest({ url: "http://example.com/mirror" });
		assert.equal(refusal(text, { allowLocal: true }).code, "PINS_MALFORMED");
	});

	it("rejects a url or a repository with a space or a control character", () => {
		for (const bad of ["a b", "a\tb", "a\nb", "a\u0000b", "a\u007fb"]) {
			assert.equal(
				refusal(assetManifest({ url: `https://example.com/${bad}` })).code,
				"PINS_MALFORMED",
				JSON.stringify(bad),
			);
			const git = {
				lib: {
					path: "external/lib",
					repo: `https://github.com/o/r${bad}.git`,
					branch: "main",
					sparse: null,
				},
			};
			assert.equal(
				refusal(manifest({ git })).code,
				"PINS_MALFORMED",
				JSON.stringify(bad),
			);
		}
	});

	it("rejects a url that carries credentials", () => {
		const error = refusal(
			assetManifest({ url: "https://user:pw@example.com/m" }),
		);
		assert.match(error.message, /credentials/);
	});

	it("rejects a git path that escapes the repository", () => {
		for (const path of [
			"../outside",
			"/etc",
			"a/../../b",
			"a//b",
			"a/./b",
			"-x",
			"a\\b",
		]) {
			const text = manifest({
				git: {
					lib: {
						path,
						repo: "https://github.com/example/lib.git",
						branch: "main",
						sparse: null,
					},
				},
			});
			assert.equal(refusal(text).code, "PINS_MALFORMED", path);
		}
	});

	it("rejects a sparse path, a vendor destination and a vendor source that escape", () => {
		const git = (sparse: string[]) => ({
			lib: {
				path: "external/lib",
				repo: "https://github.com/example/lib.git",
				branch: "main",
				sparse,
			},
		});
		assert.equal(
			refusal(manifest({ git: git(["../x"]) })).code,
			"PINS_MALFORMED",
		);
		assert.equal(refusal(manifest({ git: git([]) })).code, "PINS_MALFORMED");
		for (const vendor of [
			{ from: "OpenSesame", path: "skills/x", dest: "../x" },
			{ from: "OpenSesame", path: "/abs", dest: "tools/x" },
			{ from: "../Other", path: "skills/x", dest: "tools/x" },
		]) {
			assert.equal(
				refusal(manifest({ vendor: { v: vendor } })).code,
				"PINS_MALFORMED",
			);
		}
	});

	it("rejects an entry that is not a plain file name and a size that is not a positive integer", () => {
		assert.match(
			refusal(assetManifest({ entry: "bin/mirror" })).message,
			/entry/,
		);
		assert.match(refusal(assetManifest({ entry: ".." })).message, /entry/);
		for (const size of [0, -1, 1.5, "10"]) {
			assert.match(refusal(assetManifest({ size })).message, /size/);
		}
	});

	it("rejects an unknown schema version, an unknown key and a name used twice", () => {
		assert.match(
			refusal(manifest({ schemaVersion: 2 })).message,
			/schemaVersion/,
		);
		assert.match(refusal(manifest({ extra: 1 })).message, /extra/);
		assert.match(
			refusal(manifest({ assets: { "ts-autocode": null } })).message,
			/ts-autocode/,
		);
		assert.equal(refusal("{not json").code, "PINS_MALFORMED");
	});

	it("rejects a pin name that is not lowercase letters, digits and dashes", () => {
		for (const name of ["Bad", "a.b", "-x", "__proto__", "a b"]) {
			const text = `{"schemaVersion":1,"git":{},"assets":{${JSON.stringify(name)}:null},"vendor":{}}`;
			assert.equal(refusal(text).code, "PINS_MALFORMED", name);
		}
	});

	it("returns a frozen result", () => {
		const pins: Pins = parsePins(assetManifest({}));
		assert.ok(Object.isFrozen(pins));
		assert.ok(Object.isFrozen(pins.git));
		assert.ok(Object.isFrozen(pins.git["ts-autocode"]));
		const mirror = pins.assets.mirror;
		assert.ok(mirror !== null && mirror !== undefined);
		assert.ok(Object.isFrozen(mirror.files["linux-x64"]));
	});
});

describe("assetFor", () => {
	const pin: AssetPin = (() => {
		const parsed = parsePins(assetManifest({})).assets.mirror;
		assert.ok(parsed !== null && parsed !== undefined);
		return parsed;
	})();

	it("returns the file published for the target", () => {
		assert.equal(assetFor(pin, "mirror", "linux-x64").sha256, DIGEST);
	});

	it("refuses an unsupported target and lists the supported ones", () => {
		assert.throws(
			() => assetFor(pin, "mirror", "darwin-arm64"),
			(error: Error) =>
				error instanceof PinsError &&
				error.code === "TARGET_UNSUPPORTED" &&
				/darwin-arm64/.test(error.message) &&
				/linux-x64/.test(error.message),
		);
	});

	it("does not find a build under a name from the prototype chain", () => {
		for (const target of ["constructor", "__proto__", "toString"]) {
			assert.throws(
				() => assetFor(pin, "mirror", target),
				(error: Error) =>
					error instanceof PinsError && error.code === "TARGET_UNSUPPORTED",
			);
		}
	});

	it("names this machine's target as platform-arch", () => {
		assert.equal(currentTarget("linux", "x64"), "linux-x64");
		assert.equal(currentTarget("linux", "arm64"), "linux-arm64");
		assert.match(currentTarget(), /^[a-z0-9]+-[a-z0-9_]+$/);
	});
});

describe("isSafeRef and releaseBase", () => {
	it("accepts commits, branches and tags and refuses what git would read as an option or a walk", () => {
		for (const ok of [
			"main",
			"91af43f",
			"v1.2.3",
			"feature/x-y",
			"a".repeat(40),
		]) {
			assert.equal(isSafeRef(ok), true, ok);
		}
		for (const bad of [
			"",
			"-x",
			"--upload-pack=evil",
			"a..b",
			"a//b",
			"x y",
			"a;b",
			"$(id)",
		]) {
			assert.equal(isSafeRef(bad), false, bad);
		}
	});

	it("finds a release's assets under the repository URL, with or without .git", () => {
		assert.equal(
			releaseBase("https://github.com/o/r.git", "v1.0.0"),
			"https://github.com/o/r/releases/download/v1.0.0/",
		);
		assert.equal(
			releaseBase("https://github.com/o/r/", "v1.0.0"),
			"https://github.com/o/r/releases/download/v1.0.0/",
		);
	});
});
