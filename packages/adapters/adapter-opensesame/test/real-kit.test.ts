import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeTrust } from "../src/trust.js";
import {
	KIT_ENV,
	KitError,
	resolveKit,
	TEST_BUILD_MARKER,
} from "./real/kit.js";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hobo-kit-test-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function codeOf(env: NodeJS.ProcessEnv): string {
	try {
		resolveKit(env);
	} catch (error) {
		if (error instanceof KitError) return error.code;
		throw error;
	}
	return "no error";
}

/**
 * A complete kit at `root`, made the way a person's shell makes one: `dirMode` for
 * the directories and `fileMode` for the files, whatever the umask of this process.
 */
function fillKit(
	pluginBytes: string,
	root = dir,
	dirMode = 0o755,
	fileMode = 0o644,
): void {
	const parser = join(root, "bridge", "node_modules", "@env-spec", "parser");
	mkdirSync(parser, { recursive: true });
	writeFileSync(join(root, "opensesame"), "x");
	writeFileSync(join(root, "opensesame-surrogate-proxy"), pluginBytes);
	writeFileSync(join(root, "bridge", "opensesame-env-parse.mjs"), "x");
	for (const place of [root, join(root, "bridge")]) chmodSync(place, dirMode);
	for (const file of [
		join(root, "opensesame"),
		join(root, "opensesame-surrogate-proxy"),
		join(root, "bridge", "opensesame-env-parse.mjs"),
	]) {
		chmodSync(file, fileMode);
	}
}

describe("resolveKit: the real lane fails, never skips", () => {
	it("is KIT_REQUIRED, with the way to build one, when HOBO_OPENSESAME_KIT is unset or empty", () => {
		expect(codeOf({})).toBe("KIT_REQUIRED");
		expect(codeOf({ [KIT_ENV]: "" })).toBe("KIT_REQUIRED");
		try {
			resolveKit({});
		} catch (error) {
			expect(String(error)).toContain("cargo +1.88.0 build -p opensesame-cli");
			expect(String(error)).toContain("--features upstream-override");
		}
	});

	it("is KIT_INCOMPLETE, naming what is missing, for a directory without the pieces", () => {
		expect(codeOf({ [KIT_ENV]: dir })).toBe("KIT_INCOMPLETE");
		try {
			resolveKit({ [KIT_ENV]: dir });
		} catch (error) {
			expect(String(error)).toContain("opensesame-surrogate-proxy");
			expect(String(error)).toContain("bridge/node_modules/@env-spec/parser");
		}
	});

	it("is KIT_NOT_TEST_BUILD for a plugin that cannot be aimed at a loopback server", () => {
		fillKit("a shipped build");
		expect(codeOf({ [KIT_ENV]: dir })).toBe("KIT_NOT_TEST_BUILD");
	});

	it("accepts a complete kit with the test build of the plugin", () => {
		fillKit(`bytes ${TEST_BUILD_MARKER} bytes`);
		expect(resolveKit({ [KIT_ENV]: dir })).toEqual({
			dir,
			opensesame: join(dir, "opensesame"),
			plugin: join(dir, "opensesame-surrogate-proxy"),
			bridge: join(dir, "bridge", "opensesame-env-parse.mjs"),
		});
	});
});

describe("resolveKit: the bridge is what the adapter hands OpenSesame as OPENSESAME_ENV_PARSE, so it must pass the trust rule", () => {
	const PLUGIN = `bytes ${TEST_BUILD_MARKER} bytes`;

	function said(env: NodeJS.ProcessEnv, cwd = "/nowhere"): KitError {
		try {
			resolveKit(env, { ...nodeTrust(), cwd });
		} catch (error) {
			if (error instanceof KitError) return error;
			throw error;
		}
		throw new Error("the kit was accepted");
	}

	it("accepts a kit built with umask 022 (0755 directories, 0644 files) outside the working directory", () => {
		fillKit(PLUGIN);
		expect(() =>
			resolveKit({ [KIT_ENV]: dir }, { ...nodeTrust(), cwd: "/nowhere" }),
		).not.toThrow();
	});

	it("is KIT_UNTRUSTED for a kit built with umask 002 (0775 and 0664: the Debian and Ubuntu default), naming the fix", () => {
		fillKit(PLUGIN, dir, 0o775, 0o664);
		const error = said({ [KIT_ENV]: dir });
		expect(error.code).toBe("KIT_UNTRUSTED");
		expect(error.message).toContain("writable by group or others");
		expect(error.message).toContain("umask 022");
		expect(error.message).toContain("chmod -R go-w");
		expect(error.message).toContain("bridge_missing");
	});

	it("is KIT_UNTRUSTED when only the directories, or only the bridge script, can be written by group or others", () => {
		fillKit(PLUGIN, dir, 0o775, 0o644);
		expect(said({ [KIT_ENV]: dir }).code).toBe("KIT_UNTRUSTED");
		fillKit(PLUGIN, dir, 0o755, 0o664);
		expect(said({ [KIT_ENV]: dir }).code).toBe("KIT_UNTRUSTED");
	});

	it("is KIT_UNTRUSTED for a kit inside the working directory's tree, which a checkout controls", () => {
		fillKit(PLUGIN);
		const error = said({ [KIT_ENV]: dir }, dir);
		expect(error.code).toBe("KIT_UNTRUSTED");
		expect(error.message).toContain("working directory");
	});

	it("is KIT_UNTRUSTED for a relative HOBO_OPENSESAME_KIT, which means the working directory", () => {
		fillKit(PLUGIN);
		const error = said({ [KIT_ENV]: relative(process.cwd(), dir) });
		expect(error.code).toBe("KIT_UNTRUSTED");
		expect(error.message).toContain("absolute path");
	});

	it("is KIT_UNTRUSTED for a kit under node_modules/.bin, where a dependency can put a program of any name", () => {
		const under = join(dir, "node_modules", ".bin", "kit");
		fillKit(PLUGIN, under);
		const error = said({ [KIT_ENV]: under });
		expect(error.code).toBe("KIT_UNTRUSTED");
		expect(error.message).toContain("node_modules/.bin");
	});
});
