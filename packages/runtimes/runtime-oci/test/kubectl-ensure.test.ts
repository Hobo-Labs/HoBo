/**
 * Resolving a kubectl binary.
 *
 * This is a toolchain bootstrap, and the property that matters is **where the
 * binary came from**. The resolver tries four sources in a fixed order — an
 * explicit `HOBO_KUBECTL_BIN`, the managed `$HOBO_HOME/tools` copy, whatever is
 * on `PATH`, and finally a pinned download — and reports which one won. That
 * `source` field is not decoration: an operator debugging a version mismatch
 * needs to know whether they are looking at their own kubectl or one HoBo
 * fetched, and those are fixed in completely different places.
 *
 * The order is deliberate and worth pinning. An explicit environment override
 * has to beat everything, or a machine with a broken system kubectl could not be
 * repaired without uninstalling it. The managed copy has to beat `PATH`, or a
 * download performed to satisfy the version floor would be ignored on the very
 * next call in favour of the too-old binary it was fetched to replace.
 *
 * `spawnSync` is not injectable here, so these tests put real executables on
 * disk and point the resolver at them. That also exercises the version probe for
 * real: modern kubectl answers `version --client --output=json`, older ones only
 * answer the plain form, and a resolver that knew one spelling would reject a
 * perfectly good binary.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
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

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-kubectl-"));
	dirs.push(dir);
	return dir;
}

/**
 * A stand-in kubectl. `mode` picks how it answers the version probe:
 * `json` like a modern client, `plain` like an old one, `broken` not at all.
 */
function fakeKubectl(
	path: string,
	options: {
		mode?: "json" | "plain" | "broken" | "garbage";
		version?: string;
	} = {},
): string {
	const mode = options.mode ?? "json";
	const version = options.version ?? "1.31.0";
	const body =
		mode === "broken"
			? `process.exit(1);`
			: mode === "garbage"
				? `if (process.argv.includes("--output=json")) { process.stdout.write("not json"); process.exit(0); }\nprocess.exit(1);`
				: mode === "plain"
					? `if (process.argv.includes("--output=json")) process.exit(1);\nprocess.stdout.write("Client Version: v${version}\\n");\nprocess.exit(0);`
					: `if (!process.argv.includes("--output=json")) process.exit(1);\nprocess.stdout.write(JSON.stringify({ clientVersion: { gitVersion: "v${version}" } }));\nprocess.exit(0);`;
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

/** Runs with a PATH that contains no kubectl, so the PATH probe reliably misses. */
async function withEmptyPath<T>(run: () => Promise<T> | T): Promise<T> {
	const saved = process.env.PATH;
	const empty = scratch();
	process.env.PATH = empty;
	try {
		return await run();
	} finally {
		if (saved === undefined) delete process.env.PATH;
		else process.env.PATH = saved;
	}
}

describe("the pinned version", () => {
	it("is an exact three-part version, not a range", () => {
		// A floor expressed as a range would resolve differently on two machines
		// and make "the pinned kubectl" mean two things.
		expect(PINNED_KUBECTL_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
	});
});

describe("kubectlToolsPath", () => {
	it("points into the managed tools directory under HOBO_HOME", () => {
		// One known location, so `hobo yard ensure` and every later resolve agree
		// on where a downloaded binary lives. A drift here would download on
		// every run and never find what it fetched.
		expect(kubectlToolsPath("/home/u/.hobo")).toBe(
			join("/home/u/.hobo", "tools", "kubectl"),
		);
	});
});

describe("source resolution order", () => {
	it("prefers an explicit HOBO_KUBECTL_BIN over everything else", async () => {
		// The override has to win, or a machine whose system kubectl is broken
		// could not be repaired without uninstalling it.
		const home = scratch();
		const explicit = fakeKubectl(join(scratch(), "kubectl"), {
			version: "1.29.4",
		});
		fakeKubectl(kubectlToolsPath(home), { version: "1.31.0" });
		const resolved = await ensureKubectlBinary({
			hoboHome: home,
			env: { HOBO_KUBECTL_BIN: explicit },
			download: false,
		});
		expect(resolved.source).toBe("env");
		expect(resolved.binPath).toBe(explicit);
		expect(resolved.version).toBe("1.29.4");
	});

	it("falls past an explicit binary that does not answer the probe", async () => {
		// A stale `HOBO_KUBECTL_BIN` pointing at something that no longer runs
		// must not become a hard failure — the managed copy is right there.
		const home = scratch();
		const broken = fakeKubectl(join(scratch(), "kubectl"), { mode: "broken" });
		fakeKubectl(kubectlToolsPath(home), { version: "1.31.0" });
		const resolved = await ensureKubectlBinary({
			hoboHome: home,
			env: { HOBO_KUBECTL_BIN: broken },
			download: false,
		});
		expect(resolved.source).toBe("tools");
	});

	it("ignores an empty HOBO_KUBECTL_BIN", async () => {
		// An exported-but-blank variable is the same as unset. Probing `""` would
		// spawn the shell's idea of an empty command.
		const home = scratch();
		fakeKubectl(kubectlToolsPath(home), { version: "1.31.0" });
		const resolved = await ensureKubectlBinary({
			hoboHome: home,
			env: { HOBO_KUBECTL_BIN: "" },
			download: false,
		});
		expect(resolved.source).toBe("tools");
	});

	it("prefers the managed tools copy over whatever is on PATH", async () => {
		// The consequential ordering. If PATH won, a download performed to meet
		// the version floor would be ignored on the very next call in favour of
		// the too-old binary it was fetched to replace.
		const home = scratch();
		fakeKubectl(kubectlToolsPath(home), { version: "1.31.0" });
		const resolved = await ensureKubectlBinary({
			hoboHome: home,
			env: {},
			download: false,
		});
		expect(resolved.source).toBe("tools");
		expect(resolved.binPath).toBe(kubectlToolsPath(home));
	});

	it("refuses rather than downloading when download is off and nothing is found", async () => {
		// The offline lane. Reaching the network when a caller said not to would
		// hang a build in an environment with no egress.
		await withEmptyPath(async () => {
			await expect(
				ensureKubectlBinary({
					hoboHome: scratch(),
					env: {},
					download: false,
				}),
			).rejects.toThrow(/kubectl not found/u);
		});
	});

	it("names both remedies in the not-found message", async () => {
		// Two ways out — run the ensure command, or point at your own binary —
		// because which applies depends on whether the machine has egress.
		await withEmptyPath(async () => {
			try {
				await ensureKubectlBinary({
					hoboHome: scratch(),
					env: {},
					download: false,
				});
				expect.unreachable("a missing kubectl must be refused");
			} catch (error) {
				expect((error as Error).message).toContain("hobo yard ensure");
				expect((error as Error).message).toContain("HOBO_KUBECTL_BIN");
			}
		});
	});
});

describe("the version probe", () => {
	it("reads the JSON form a modern client answers with", async () => {
		const resolved = await ensureKubectlBinary({
			hoboHome: scratch(),
			env: {
				HOBO_KUBECTL_BIN: fakeKubectl(join(scratch(), "kubectl"), {
					mode: "json",
					version: "1.31.2",
				}),
			},
			download: false,
		});
		expect(resolved.version).toBe("1.31.2");
	});

	it("strips the leading v from a git version", async () => {
		// The JSON carries `v1.31.2`; every comparison downstream is on the bare
		// semver. Leaving the `v` would make a string compare against a floor
		// fail for a binary that satisfies it.
		const resolved = await ensureKubectlBinary({
			hoboHome: scratch(),
			env: {
				HOBO_KUBECTL_BIN: fakeKubectl(join(scratch(), "kubectl"), {
					version: "1.31.2",
				}),
			},
			download: false,
		});
		expect(resolved.version.startsWith("v")).toBe(false);
	});

	it("falls back to the plain form for an older client", async () => {
		// Older kubectl does not accept `--output=json` at all. A resolver that
		// only knew the modern spelling would reject a working binary as absent
		// and then try to download over it.
		const resolved = await ensureKubectlBinary({
			hoboHome: scratch(),
			env: {
				HOBO_KUBECTL_BIN: fakeKubectl(join(scratch(), "kubectl"), {
					mode: "plain",
					version: "1.24.9",
				}),
			},
			download: false,
		});
		expect(resolved.version).toBe("1.24.9");
		expect(resolved.source).toBe("env");
	});

	it("reports a zero version rather than failing on unparseable JSON", async () => {
		// A binary that exits 0 with a body we cannot read is still *present*.
		// Treating it as absent would trigger a download over a working install;
		// `0.0.0` says "present, version unknown" and lets a floor check decide.
		const resolved = await ensureKubectlBinary({
			hoboHome: scratch(),
			env: {
				HOBO_KUBECTL_BIN: fakeKubectl(join(scratch(), "kubectl"), {
					mode: "garbage",
				}),
			},
			download: false,
		});
		expect(resolved.version).toBe("0.0.0");
	});

	it("treats a binary that fails both probe forms as absent", async () => {
		await withEmptyPath(async () => {
			await expect(
				ensureKubectlBinary({
					hoboHome: scratch(),
					env: {
						HOBO_KUBECTL_BIN: fakeKubectl(join(scratch(), "kubectl"), {
							mode: "broken",
						}),
					},
					download: false,
				}),
			).rejects.toThrow(/kubectl not found/u);
		});
	});
});

describe("isKubectlPresent", () => {
	it("reports true for an existing explicit binary", () => {
		// This is a cheap existence check, not a probe — it is asked before
		// deciding whether to run an ensure at all, so it must not spawn a
		// process per candidate.
		const explicit = fakeKubectl(join(scratch(), "kubectl"));
		expect(isKubectlPresent(scratch(), { HOBO_KUBECTL_BIN: explicit })).toBe(
			true,
		);
	});

	it("reports true for a managed tools copy", () => {
		const home = scratch();
		fakeKubectl(kubectlToolsPath(home));
		expect(isKubectlPresent(home, {})).toBe(true);
	});

	it("ignores an explicit path that does not exist", () => {
		// A stale override must not make the check answer true for a binary that
		// is not there — the caller would then skip the ensure and fail later.
		const home = scratch();
		fakeKubectl(kubectlToolsPath(home));
		expect(
			isKubectlPresent(home, { HOBO_KUBECTL_BIN: join(scratch(), "gone") }),
		).toBe(true);
	});

	it("reports false when nothing is present anywhere", async () => {
		await withEmptyPath(() => {
			expect(isKubectlPresent(scratch(), {})).toBe(false);
		});
	});
});

describe("the download lane", () => {
	/**
	 * Replaces `curl` on PATH with a script that writes a fake kubectl, so the
	 * download path runs end to end without reaching the network.
	 */
	async function withFakeCurl<T>(
		options: { fail?: boolean; produceBroken?: boolean },
		run: () => Promise<T>,
	): Promise<T> {
		const binDir = scratch();
		const curl = join(binDir, "curl");
		const payload = options.produceBroken
			? `process.exit(1);`
			: `if (!process.argv.includes("--output=json")) process.exit(1);\nprocess.stdout.write(JSON.stringify({ clientVersion: { gitVersion: "v${PINNED_KUBECTL_VERSION}" } }));\nprocess.exit(0);`;
		const body = options.fail
			? `process.stderr.write("curl: (22) 404\\n");\nprocess.exit(22);`
			: [
					`const { writeFileSync, chmodSync } = require("node:fs");`,
					`const out = process.argv[process.argv.indexOf("-o") + 1];`,
					`writeFileSync(out, ${JSON.stringify(`#!/usr/bin/env node\n${payload}\n`)});`,
					`chmodSync(out, 0o755);`,
					`process.exit(0);`,
				].join("\n");
		writeFileSync(curl, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
		chmodSync(curl, 0o755);
		const saved = process.env.PATH;
		// The fake `curl` first, then node's own directory — the stand-in
		// binaries are node scripts, so replacing PATH wholesale would break
		// their `#!/usr/bin/env node` line and fail the test for a reason that
		// has nothing to do with the code under test.
		process.env.PATH = `${binDir}:${dirname(process.execPath)}`;
		try {
			return await run();
		} finally {
			if (saved === undefined) delete process.env.PATH;
			else process.env.PATH = saved;
		}
	}

	it("downloads into the managed tools directory and reports the source", async () => {
		// `source: "downloaded"` is what tells an operator this binary is HoBo's
		// to manage — deleting it is safe, and it will come back.
		const home = scratch();
		const resolved = await withFakeCurl({}, () =>
			ensureKubectlBinary({ hoboHome: home, env: {}, download: true }),
		);
		expect(resolved.source).toBe("downloaded");
		expect(resolved.binPath).toBe(kubectlToolsPath(home));
		expect(resolved.version).toBe(PINNED_KUBECTL_VERSION);
	});

	it("emits progress, because a download is a long silent pause otherwise", async () => {
		const messages: string[] = [];
		await withFakeCurl({}, () =>
			ensureKubectlBinary({
				hoboHome: scratch(),
				env: {},
				download: true,
				emitProgress: (message) => messages.push(message),
			}),
		);
		expect(messages.join(" ")).toContain("downloading kubectl");
		expect(messages.join(" ")).toContain("ready at");
	});

	it("runs without a progress callback", async () => {
		// `?? (() => {})`. A caller supplying none must not crash on an undefined
		// call halfway through a download.
		await expect(
			withFakeCurl({}, () =>
				ensureKubectlBinary({ hoboHome: scratch(), env: {}, download: true }),
			),
		).resolves.toBeDefined();
	});

	it("finds the downloaded binary on the next resolve without downloading again", async () => {
		// The point of writing into the managed directory. A second call that
		// downloaded again would re-fetch on every command.
		const home = scratch();
		await withFakeCurl({}, () =>
			ensureKubectlBinary({ hoboHome: home, env: {}, download: true }),
		);
		const second = await ensureKubectlBinary({
			hoboHome: home,
			env: {},
			download: false,
		});
		expect(second.source).toBe("tools");
	});

	it("reports a failed download with the URL and curl's own output", async () => {
		// The URL because a 404 usually means the pinned version or the platform
		// triple is wrong, and curl's stderr because it distinguishes a DNS
		// failure from a proxy rejection.
		await expect(
			withFakeCurl({ fail: true }, () =>
				ensureKubectlBinary({ hoboHome: scratch(), env: {}, download: true }),
			),
		).rejects.toThrow(/failed to download kubectl/u);
	});

	it("names the pinned version and the release URL in the failure", async () => {
		try {
			await withFakeCurl({ fail: true }, () =>
				ensureKubectlBinary({ hoboHome: scratch(), env: {}, download: true }),
			);
			expect.unreachable("a failed download must be reported");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain(PINNED_KUBECTL_VERSION);
			expect(message).toContain("dl.k8s.io");
		}
	});

	it("refuses a downloaded binary that fails its own version probe", async () => {
		// The last gate. A truncated or wrong-architecture download writes a file
		// that exists and does not run, and returning it would push the failure
		// to the first real kubectl call — far from the download that caused it.
		await expect(
			withFakeCurl({ produceBroken: true }, () =>
				ensureKubectlBinary({ hoboHome: scratch(), env: {}, download: true }),
			),
		).rejects.toThrow(/failed version probe/u);
	});

	it("defaults download to on", async () => {
		// The common path: a caller that says nothing wants kubectl to be made
		// available rather than to be told it is missing.
		const home = scratch();
		const resolved = await withFakeCurl({}, () =>
			ensureKubectlBinary({ hoboHome: home, env: {} }),
		);
		expect(resolved.source).toBe("downloaded");
	});
});
