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
		expect(PINNED_KUBECTL_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
	});
});

describe("kubectlToolsPath", () => {
	it("points into the managed tools directory under HOBO_HOME", () => {
		expect(kubectlToolsPath("/home/u/.hobo")).toBe(
			join("/home/u/.hobo", "tools", "kubectl"),
		);
	});
});

describe("source resolution order", () => {
	it("prefers an explicit HOBO_KUBECTL_BIN over everything else", async () => {
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
		process.env.PATH = `${binDir}:${dirname(process.execPath)}`;
		try {
			return await run();
		} finally {
			if (saved === undefined) delete process.env.PATH;
			else process.env.PATH = saved;
		}
	}

	it("downloads into the managed tools directory and reports the source", async () => {
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
		await expect(
			withFakeCurl({}, () =>
				ensureKubectlBinary({ hoboHome: scratch(), env: {}, download: true }),
			),
		).resolves.toBeDefined();
	});

	it("finds the downloaded binary on the next resolve without downloading again", async () => {
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
		await expect(
			withFakeCurl({ produceBroken: true }, () =>
				ensureKubectlBinary({ hoboHome: scratch(), env: {}, download: true }),
			),
		).rejects.toThrow(/failed version probe/u);
	});

	it("defaults download to on", async () => {
		const home = scratch();
		const resolved = await withFakeCurl({}, () =>
			ensureKubectlBinary({ hoboHome: home, env: {} }),
		);
		expect(resolved.source).toBe("downloaded");
	});
});
