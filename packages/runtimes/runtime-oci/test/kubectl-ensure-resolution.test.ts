import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	ensureKubectlBinary,
	isKubectlPresent,
	kubectlToolsPath,
	PINNED_KUBECTL_VERSION,
} from "../src/kubectl-ensure.js";

const dirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = originalPath;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-kubectl-"));
	dirs.push(dir);
	return dir;
}

function writeKubectl(
	path: string,
	answers: { json?: string | null; plain?: string | null },
): string {
	mkdirSync(dirname(path), { recursive: true });
	const { json = null, plain = null } = answers;
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2).join(' ');",
			"const isJson = args.includes('--output=json');",
			`const json = ${JSON.stringify(json)};`,
			`const plain = ${JSON.stringify(plain)};`,
			"const answer = isJson ? json : plain;",
			"if (answer === null) { process.exit(1); }",
			"process.stdout.write(answer);",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(path, 0o755);
	return path;
}

const clientJson = (version: string) =>
	JSON.stringify({ clientVersion: { gitVersion: `v${version}` } });

function standIn(version = "1.31.0"): string {
	return writeKubectl(join(tempDir(), "kubectl"), {
		json: clientJson(version),
	});
}

function hoboHomeWith(version?: string): string {
	const home = tempDir();
	if (version !== undefined) {
		writeKubectl(kubectlToolsPath(home), { json: clientJson(version) });
	}
	return home;
}

function emptyPath(): void {
	process.env.PATH = dirname(process.execPath);
}

describe("resolution order", () => {
	it("prefers HOBO_KUBECTL_BIN", async () => {
		const named = standIn("1.33.0");
		const result = await ensureKubectlBinary({
			hoboHome: hoboHomeWith("1.31.0"),
			env: { HOBO_KUBECTL_BIN: named },
			download: false,
		});
		expect(result).toMatchObject({ binPath: named, source: "env" });
	});

	it("reports the named binary's own version", async () => {
		const result = await ensureKubectlBinary({
			hoboHome: hoboHomeWith(),
			env: { HOBO_KUBECTL_BIN: standIn("1.33.2") },
			download: false,
		});
		expect(result.version).toBe("1.33.2");
	});

	it("falls through when HOBO_KUBECTL_BIN does not answer the probe", async () => {
		const broken = writeKubectl(join(tempDir(), "kubectl"), {
			json: null,
			plain: null,
		});
		const result = await ensureKubectlBinary({
			hoboHome: hoboHomeWith("1.31.0"),
			env: { HOBO_KUBECTL_BIN: broken },
			download: false,
		});
		expect(result.source).toBe("tools");
	});

	it("falls through when HOBO_KUBECTL_BIN points at nothing", async () => {
		const result = await ensureKubectlBinary({
			hoboHome: hoboHomeWith("1.31.0"),
			env: { HOBO_KUBECTL_BIN: join(tempDir(), "absent") },
			download: false,
		});
		expect(result.source).toBe("tools");
	});

	it("ignores an empty HOBO_KUBECTL_BIN", async () => {
		const result = await ensureKubectlBinary({
			hoboHome: hoboHomeWith("1.31.0"),
			env: { HOBO_KUBECTL_BIN: "" },
			download: false,
		});
		expect(result.source).toBe("tools");
	});

	it("uses the equipped tools copy next", async () => {
		const home = hoboHomeWith("1.31.0");
		const result = await ensureKubectlBinary({
			hoboHome: home,
			env: {},
			download: false,
		});
		expect(result).toMatchObject({
			binPath: kubectlToolsPath(home),
			source: "tools",
		});
	});

	it("falls through when the tools copy does not answer", async () => {
		const home = tempDir();
		writeKubectl(kubectlToolsPath(home), { json: null, plain: null });
		emptyPath();
		await expect(
			ensureKubectlBinary({ hoboHome: home, env: {}, download: false }),
		).rejects.toThrow(/kubectl not found/);
	});

	it("uses kubectl on PATH last", async () => {
		const dir = tempDir();
		writeKubectl(join(dir, "kubectl"), { json: clientJson("1.30.0") });
		process.env.PATH = `${dir}:${dirname(process.execPath)}`;
		const result = await ensureKubectlBinary({
			hoboHome: hoboHomeWith(),
			env: {},
			download: false,
		});
		expect(result).toMatchObject({ binPath: "kubectl", source: "path" });
	});
});

describe("when nothing is found", () => {
	it("refuses rather than downloading when download is off", async () => {
		emptyPath();
		await expect(
			ensureKubectlBinary({
				hoboHome: hoboHomeWith(),
				env: {},
				download: false,
			}),
		).rejects.toThrow(/kubectl not found/);
	});

	it("names both ways out", async () => {
		emptyPath();
		await expect(
			ensureKubectlBinary({
				hoboHome: hoboHomeWith(),
				env: {},
				download: false,
			}),
		).rejects.toThrow(/hobo yard ensure.*HOBO_KUBECTL_BIN/s);
	});
});

describe("reading a client's version", () => {
	const versionOf = async (answers: {
		json?: string | null;
		plain?: string | null;
	}) =>
		(
			await ensureKubectlBinary({
				hoboHome: hoboHomeWith(),
				env: {
					HOBO_KUBECTL_BIN: writeKubectl(join(tempDir(), "kubectl"), answers),
				},
				download: false,
			})
		).version;

	it("strips the leading v from gitVersion", async () => {
		expect(await versionOf({ json: clientJson("1.31.0") })).toBe("1.31.0");
	});

	it("keeps a gitVersion that has no leading v", async () => {
		expect(
			await versionOf({
				json: JSON.stringify({ clientVersion: { gitVersion: "1.31.0" } }),
			}),
		).toBe("1.31.0");
	});

	it("falls back to 0.0.0 when the JSON has no gitVersion", async () => {
		expect(
			await versionOf({ json: JSON.stringify({ clientVersion: {} }) }),
		).toBe("0.0.0");
	});

	it("falls back to 0.0.0 when the JSON has no clientVersion at all", async () => {
		expect(await versionOf({ json: "{}" })).toBe("0.0.0");
	});

	it("falls back to 0.0.0 when the output is not JSON", async () => {
		expect(await versionOf({ json: "not json at all" })).toBe("0.0.0");
	});

	it("reads the plain output an older client prints", async () => {
		expect(
			await versionOf({ json: null, plain: "Client Version: v1.28.4\n" }),
		).toBe("1.28.4");
	});

	it("reads plain output without the v", async () => {
		expect(
			await versionOf({ json: null, plain: "Client Version: 1.28.4\n" }),
		).toBe("1.28.4");
	});

	it("matches the plain label case-insensitively", async () => {
		expect(
			await versionOf({ json: null, plain: "client version: v1.28.4\n" }),
		).toBe("1.28.4");
	});

	it("falls back to 0.0.0 when the plain output has no version", async () => {
		expect(await versionOf({ json: null, plain: "some other banner\n" })).toBe(
			"0.0.0",
		);
	});

	it("treats a binary that fails both forms as absent", async () => {
		emptyPath();
		const broken = writeKubectl(join(tempDir(), "kubectl"), {
			json: null,
			plain: null,
		});
		await expect(
			ensureKubectlBinary({
				hoboHome: hoboHomeWith(),
				env: { HOBO_KUBECTL_BIN: broken },
				download: false,
			}),
		).rejects.toThrow(/kubectl not found/);
	});
});

describe("isKubectlPresent", () => {
	it("accepts a HOBO_KUBECTL_BIN that exists", () => {
		expect(
			isKubectlPresent(hoboHomeWith(), { HOBO_KUBECTL_BIN: standIn() }),
		).toBe(true);
	});

	it("refuses a HOBO_KUBECTL_BIN that does not exist", () => {
		emptyPath();
		expect(
			isKubectlPresent(hoboHomeWith(), {
				HOBO_KUBECTL_BIN: join(tempDir(), "absent"),
			}),
		).toBe(false);
	});

	it("accepts an equipped tools copy", () => {
		expect(isKubectlPresent(hoboHomeWith("1.31.0"), {})).toBe(true);
	});

	it("accepts a kubectl on PATH", () => {
		const dir = tempDir();
		writeKubectl(join(dir, "kubectl"), { json: clientJson("1.31.0") });
		process.env.PATH = `${dir}:${dirname(process.execPath)}`;
		expect(isKubectlPresent(hoboHomeWith(), {})).toBe(true);
	});

	it("reports absent when there is nothing anywhere", () => {
		emptyPath();
		expect(isKubectlPresent(hoboHomeWith(), {})).toBe(false);
	});
});

describe("the equipped location", () => {
	it("is tools/kubectl under HOBO_HOME", () => {
		expect(kubectlToolsPath("/opt/hobo")).toBe("/opt/hobo/tools/kubectl");
	});

	it("pins a known kubectl version for the download path", () => {
		expect(PINNED_KUBECTL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("downloading a pinned client", () => {
	function curlWriting(writes: string | null): void {
		const dir = tempDir();
		writeFileSync(
			join(dir, "curl"),
			[
				"#!/usr/bin/env node",
				"const fs = require('node:fs');",
				`const writes = ${JSON.stringify(writes)};`,
				"if (writes === null) {",
				"  process.stderr.write('curl: (22) 404');",
				"  process.exit(22);",
				"}",
				"const args = process.argv.slice(2);",
				"const out = args[args.indexOf('-o') + 1];",
				"fs.writeFileSync(out, writes, { mode: 0o755 });",
			].join("\n"),
			{ mode: 0o755 },
		);
		chmodSync(join(dir, "curl"), 0o755);
		process.env.PATH = `${dir}:${dirname(process.execPath)}`;
	}

	function kubectlBody(version: string | null): string {
		const path = writeKubectl(
			join(tempDir(), "kubectl"),
			version === null
				? { json: null, plain: null }
				: { json: clientJson(version) },
		);
		return readFileSync(path, "utf8");
	}

	it("equips the downloaded client into the tools directory", async () => {
		curlWriting(kubectlBody("1.31.0"));
		const home = tempDir();
		const result = await ensureKubectlBinary({ hoboHome: home, env: {} });
		expect(result).toMatchObject({
			binPath: kubectlToolsPath(home),
			source: "downloaded",
			version: "1.31.0",
		});
	});

	it("makes the equipped client executable", async () => {
		curlWriting(kubectlBody("1.31.0"));
		const home = tempDir();
		await ensureKubectlBinary({ hoboHome: home, env: {} });
		expect(statSync(kubectlToolsPath(home)).mode & 0o111).toBeGreaterThan(0);
	});

	it("is found without a download on the next ensure", async () => {
		curlWriting(kubectlBody("1.31.0"));
		const home = tempDir();
		await ensureKubectlBinary({ hoboHome: home, env: {} });
		const again = await ensureKubectlBinary({
			hoboHome: home,
			env: {},
			download: false,
		});
		expect(again.source).toBe("tools");
	});

	it("reports progress naming the version and where it is going", async () => {
		curlWriting(kubectlBody("1.31.0"));
		const home = tempDir();
		const messages: string[] = [];
		await ensureKubectlBinary({
			hoboHome: home,
			env: {},
			emitProgress: (message) => messages.push(message),
		});
		expect(messages.join("\n")).toMatch(
			new RegExp(`downloading kubectl ${PINNED_KUBECTL_VERSION}`),
		);
		expect(messages.join("\n")).toMatch(/kubectl 1\.31\.0 ready at/);
	});

	it("refuses when the fetch fails, naming the URL", async () => {
		curlWriting(null);
		await expect(
			ensureKubectlBinary({ hoboHome: tempDir(), env: {} }),
		).rejects.toThrow(/failed to download kubectl.*dl\.k8s\.io/s);
	});

	it("carries curl's own stderr into that refusal", async () => {
		curlWriting(null);
		await expect(
			ensureKubectlBinary({ hoboHome: tempDir(), env: {} }),
		).rejects.toThrow(/404/);
	});

	it("refuses a downloaded file that does not answer a version probe", async () => {
		curlWriting(kubectlBody(null));
		await expect(
			ensureKubectlBinary({ hoboHome: tempDir(), env: {} }),
		).rejects.toThrow(/failed version probe/);
	});

	it("does not download when HOBO_KUBECTL_BIN already answers", async () => {
		curlWriting(null);
		const result = await ensureKubectlBinary({
			hoboHome: tempDir(),
			env: { HOBO_KUBECTL_BIN: standIn("1.33.0") },
		});
		expect(result.source).toBe("env");
	});
});
