/**
 * Where kubectl comes from, and what "found" means.
 *
 * `ensureKubectlBinary` makes the client *equippable* — it does not check that
 * a cluster is reachable. It looks in four places in a fixed order, and the
 * order is the contract:
 *
 * 1. `HOBO_KUBECTL_BIN` — an operator who named a binary meant it.
 * 2. `$HOBO_HOME/tools/kubectl` — what a previous `hobo yard ensure` equipped.
 * 3. `kubectl` on PATH — the machine's own install.
 * 4. A download, pinned to a known version.
 *
 * Each step earlier than a download is preferred because a download is the
 * only one that touches the network, and an offline equip is the whole point
 * of the tools directory.
 *
 * Two properties are load-bearing beyond the order itself:
 *
 * **A candidate is only "found" if it answers a version probe.** An
 * `HOBO_KUBECTL_BIN` pointing at something that is not kubectl — a stale path,
 * a wrapper script that broke — falls through to the next source rather than
 * being trusted. Existence is not evidence; answering is.
 *
 * **The reported source is not decoration.** It is how an operator finds out
 * *which* kubectl their cluster commands are about to run, and a wrong one
 * sends them to edit a file that is not being used.
 *
 * The probe itself tolerates two output formats — the JSON one and the plain
 * text older clients print — because refusing an old client at the probe would
 * refuse it before the version floor could report anything useful about it.
 *
 * These drive the real `spawnSync` against stand-in `kubectl` binaries.
 * Nothing here reaches the network: the download path is exercised only by
 * being refused.
 */
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

/**
 * A stand-in `kubectl` at `path`.
 *
 * `json` answers `version --client --output=json`; `plain` answers the bare
 * `version --client` an older client prints. A null for either makes that
 * form exit non-zero, which is how the probe decides to fall back.
 */
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

/** A kubectl answering the JSON form, at its own temp path. */
function standIn(version = "1.31.0"): string {
	return writeKubectl(join(tempDir(), "kubectl"), {
		json: clientJson(version),
	});
}

/** A HOBO_HOME whose tools directory holds the given kubectl, or nothing. */
function hoboHomeWith(version?: string): string {
	const home = tempDir();
	if (version !== undefined) {
		writeKubectl(kubectlToolsPath(home), { json: clientJson(version) });
	}
	return home;
}

/** No `kubectl` reachable on PATH — node's own directory only. */
function emptyPath(): void {
	process.env.PATH = dirname(process.execPath);
}

describe("resolution order", () => {
	it("prefers HOBO_KUBECTL_BIN", async () => {
		// An operator who named a binary meant it. A tools copy that won here
		// would make the variable silently ineffective.
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
		// Existence is not evidence. A stale path or a broken wrapper must not
		// be trusted just because a variable points at it.
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
		// An exported-but-empty variable is the shell's way of saying nothing,
		// not a request to probe the empty path.
		const result = await ensureKubectlBinary({
			hoboHome: hoboHomeWith("1.31.0"),
			env: { HOBO_KUBECTL_BIN: "" },
			download: false,
		});
		expect(result.source).toBe("tools");
	});

	it("uses the equipped tools copy next", async () => {
		// The offline equip path: what a previous `hobo yard ensure` put there
		// is preferred over the machine's own install, so a yard pins its
		// client rather than inheriting whatever the host happens to have.
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
		// A truncated download or an interrupted equip leaves a file that is
		// not a working kubectl.
		const home = tempDir();
		writeKubectl(kubectlToolsPath(home), { json: null, plain: null });
		emptyPath();
		await expect(
			ensureKubectlBinary({ hoboHome: home, env: {}, download: false }),
		).rejects.toThrow(/kubectl not found/);
	});

	it("uses kubectl on PATH last", async () => {
		// Reported as `path`, not `tools`: an operator needs to know their
		// cluster commands are running the machine's install and not the
		// yard's pinned one.
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
		// The offline lane. Downloading here would turn an air-gapped equip
		// into a network call the operator explicitly opted out of.
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
		// `kubectl not found` alone leaves an operator to guess whether to
		// install one or to point the platform at one they already have.
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
		// The rest of the platform compares bare semver; a stray `v` would
		// make every comparison a string mismatch.
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
		// A client that answered but said nothing useful is still *present*, so
		// it is accepted with an unknown version rather than treated as absent
		// — the version floor is a separate concern from equipping.
		expect(
			await versionOf({ json: JSON.stringify({ clientVersion: {} }) }),
		).toBe("0.0.0");
	});

	it("falls back to 0.0.0 when the JSON has no clientVersion at all", async () => {
		expect(await versionOf({ json: "{}" })).toBe("0.0.0");
	});

	it("falls back to 0.0.0 when the output is not JSON", async () => {
		// It exited zero, so it is a working binary of some sort. Refusing it
		// here would be stricter than the contract needs.
		expect(await versionOf({ json: "not json at all" })).toBe("0.0.0");
	});

	it("reads the plain output an older client prints", async () => {
		// Older clients do not know `--output=json` and exit non-zero for it.
		// Refusing them at the probe would refuse them before the version
		// floor could say anything useful about why.
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
		// Not an error about a broken kubectl — the resolver simply moves on
		// to the next source, which is what makes the order a fallback chain
		// rather than a series of hard gates.
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
		// Deliberately weaker than `ensureKubectlBinary`: this answers "is
		// something equipped", not "does it work". A probe here would spawn a
		// process on a question asked to decide whether to *offer* an action.
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
		// Pinned because `hobo yard ensure` writes here and everything else
		// reads here; a change on either side alone silently equips nothing.
		expect(kubectlToolsPath("/opt/hobo")).toBe("/opt/hobo/tools/kubectl");
	});

	it("pins a known kubectl version for the download path", () => {
		// The download is the only unpinned-by-default source, so the pin is
		// what stops two machines equipping different clients.
		expect(PINNED_KUBECTL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("downloading a pinned client", () => {
	/**
	 * A PATH holding only a stand-in `curl` (and node, for the shebangs).
	 *
	 * The stand-in writes `writes` to whatever `-o` names, so it stands in for
	 * the fetch without reaching the network. `null` makes it fail.
	 */
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

	/** The body of a working stand-in kubectl, as a string. */
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
		// The download exists so a machine with no kubectl can still be
		// equipped; landing it in the tools directory is what makes the *next*
		// ensure offline.
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
		// Written from a buffer, so the source file's mode does not carry —
		// without an explicit chmod the very next probe would fail with EACCES.
		curlWriting(kubectlBody("1.31.0"));
		const home = tempDir();
		await ensureKubectlBinary({ hoboHome: home, env: {} });
		expect(statSync(kubectlToolsPath(home)).mode & 0o111).toBeGreaterThan(0);
	});

	it("is found without a download on the next ensure", async () => {
		// The point of equipping. A second network call here would make every
		// yard command depend on connectivity.
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
		// An equip is the slowest thing `hobo yard ensure` does; silence during
		// it reads as a hang.
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
		// The URL is the actionable half: it says which release and which
		// platform triple was asked for, so a 404 is diagnosable without
		// reading the source.
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
		// A captive portal or a proxy error page is a successful fetch of the
		// wrong bytes. Equipping it would leave a file that looks installed and
		// fails at the first real cluster command instead.
		curlWriting(kubectlBody(null));
		await expect(
			ensureKubectlBinary({ hoboHome: tempDir(), env: {} }),
		).rejects.toThrow(/failed version probe/);
	});

	it("does not download when HOBO_KUBECTL_BIN already answers", async () => {
		// Precedence still holds with downloading enabled: the network is the
		// last resort, not a parallel option.
		curlWriting(null);
		const result = await ensureKubectlBinary({
			hoboHome: tempDir(),
			env: { HOBO_KUBECTL_BIN: standIn("1.33.0") },
		});
		expect(result.source).toBe("env");
	});
});
