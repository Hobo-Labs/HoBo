/**
 * The guard on this package's home isolation.
 *
 * `test/isolate-user-home.ts` and the root's `test/setup/isolate-hobo-home.ts`
 * move HOME and HOBO_HOME for every file, and `test/real-home-guard.ts` fails
 * the run when a real HoBo home gained entries anyway. A guarantee nothing
 * checks quietly stops holding, so this file checks both halves: that the
 * homes a test sees are throwaway ones, and that the guard really fails a run
 * that writes into a home it watches. The second half runs vitest again with
 * only the guard, a HOME and a TMPDIR of its own, so it never touches the
 * machine's real `~/.hobo` or `/tmp/.hobo`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHoboHome } from "@hobo/core/hobo-home";
import { afterAll, describe, expect, it } from "vitest";

import { watchedHomes } from "./real-home-guard.js";
import {
	changedEntries,
	gainedEntries,
	removedEntries,
	snapshotHomes,
} from "./real-home-snapshot.js";

describe("the homes a test in this package sees", () => {
	it("HOME is a directory of the run's, not the account's", () => {
		const home = String(process.env.HOME);
		expect(resolve(home)).not.toBe(resolve(userInfo().homedir));
		expect(existsSync(home)).toBe(true);
	});

	it("os.homedir() is that directory too, so the pool runs tests in processes", () => {
		// In a worker thread, setting process.env.HOME does not move
		// os.homedir(), which reads the process's own environment.
		expect(homedir()).toBe(process.env.HOME);
	});

	it("the default HoBo home is not the account's ~/.hobo", () => {
		expect(resolve(resolveHoboHome())).not.toBe(
			resolve(join(userInfo().homedir, ".hobo")),
		);
		// An environment that names no home falls back to os.homedir(), which
		// reads the HOME set for this worker.
		expect(resolveHoboHome({})).toBe(join(String(process.env.HOME), ".hobo"));
	});
});

const scratch = mkdtempSync(join(tmpdir(), "hobo-real-home-guard-"));
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("comparing snapshots", () => {
	it("names files that changed or were removed, but not a directory's own mtime", () => {
		const home = join(scratch, "edited");
		mkdirSync(join(home, "durable"), { recursive: true });
		writeFileSync(join(home, "durable", "kept.json"), "{}");
		writeFileSync(join(home, "durable", "edited.json"), "{}");
		writeFileSync(join(home, "durable", "deleted.json"), "{}");
		const before = snapshotHomes([home]);
		writeFileSync(join(home, "durable", "edited.json"), '{"more":true}');
		rmSync(join(home, "durable", "deleted.json"));
		const after = snapshotHomes([home]);
		expect(changedEntries(before, after)).toEqual([
			join(home, "durable", "edited.json"),
		]);
		expect(removedEntries(before, after)).toEqual([
			join(home, "durable", "deleted.json"),
		]);
	});

	it("names what appeared, including a home that did not exist before", () => {
		const kept = join(scratch, "kept");
		const fresh = join(scratch, "fresh");
		mkdirSync(join(kept, "durable"), { recursive: true });
		const before = snapshotHomes([kept, fresh]);
		writeFileSync(join(kept, "durable", "leak.json"), "{}");
		mkdirSync(join(fresh, "runtime"), { recursive: true });
		expect(gainedEntries(before, snapshotHomes([kept, fresh]))).toEqual([
			fresh,
			join(fresh, "runtime"),
			join(kept, "durable", "leak.json"),
		]);
	});
});

describe("what the guard watches", () => {
	it("is the temp directories and account home it is given, and HOME's", () => {
		const account = join(scratch, "account");
		const temp = join(scratch, "temp");
		expect(
			watchedHomes({ HOME: join(scratch, "home") }, () => account, [temp]),
		).toEqual([
			join(temp, ".hobo"),
			join(scratch, "home", ".hobo"),
			join(account, ".hobo"),
		]);
	});
});

const GUARD = fileURLToPath(new URL("./real-home-guard.ts", import.meta.url));
/** The root of throwaway homes this package's config sets up before the guard. */
const HOMES = fileURLToPath(
	new URL("../../../test/setup/hobo-test-homes.ts", import.meta.url),
);
const VITEST = join(
	dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
	"vitest.mjs",
);

let runs = 0;

/** This package's isolation setup files, for a probe run that asks for them. */
const ISOLATION = [
	fileURLToPath(
		new URL("../../../test/setup/isolate-hobo-home.ts", import.meta.url),
	),
	fileURLToPath(new URL("./isolate-user-home.ts", import.meta.url)),
];

/**
 * Runs one probe test under the guard, with HOME and TMPDIR of its own.
 * `prepare` lays out what those homes hold before the run starts; `options`
 * adds setup files and environment (a value may name `{home}`).
 */
function runUnderGuard(
	probe: string,
	prepare: (dirs: { home: string; temp: string }) => void = () => {},
	options: {
		readonly setupFiles?: readonly string[];
		readonly env?: Readonly<Record<string, string>>;
	} = {},
) {
	runs += 1;
	const project = join(scratch, `run-${runs}`);
	const home = join(project, "home");
	const temp = join(project, "tmp");
	mkdirSync(home, { recursive: true });
	mkdirSync(temp, { recursive: true });
	prepare({ home, temp });
	writeFileSync(
		join(project, "probe.test.mjs"),
		`import { mkdirSync, rmSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nit("probes", () => {\n${probe.replaceAll("{home}", home)}\n});\n`,
	);
	// The guard watches this probe's own homes only: its HOME stands in for the
	// account's, its TMPDIR for /tmp, so a process writing the machine's real
	// ~/.hobo or /tmp/.hobo meanwhile cannot fail the probe.
	writeFileSync(
		join(project, "guard.ts"),
		`import { realHomeGuard } from ${JSON.stringify(GUARD)};\nexport default realHomeGuard({ passwd: () => ${JSON.stringify(home)}, tempDirs: [${JSON.stringify(temp)}] });\n`,
	);
	writeFileSync(
		join(project, "vitest.config.mjs"),
		`export default { test: { globals: true, include: ["probe.test.mjs"], globalSetup: [${JSON.stringify(HOMES)}, ${JSON.stringify(join(project, "guard.ts"))}], setupFiles: ${JSON.stringify(options.setupFiles ?? [])} } };\n`,
	);
	// Another vitest run of its own: none of this run's VITEST_* settings or homes.
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith("VITEST") &&
				!key.startsWith("HOBO_TEST_") &&
				key !== "HOBO_HOME",
		),
	);
	const extra = Object.fromEntries(
		Object.entries(options.env ?? {}).map(([key, value]) => [
			key,
			value.replaceAll("{home}", home),
		]),
	);
	const run = spawnSync(
		process.execPath,
		[VITEST, "run", "--root", project, "--config", "vitest.config.mjs"],
		{
			cwd: project,
			env: { ...inherited, HOME: home, TMPDIR: temp, ...extra },
			encoding: "utf8",
		},
	);
	return {
		status: run.status,
		output: `${run.stdout}${run.stderr}`,
		home: realpathSync(home),
		temp: realpathSync(temp),
	};
}

describe("walking a home a live session is churning", () => {
	it("never reports an entry the session did not touch", async () => {
		// A HoBo session removes and recreates sandboxes/<runId> while the guard
		// walks. A listing that failed on one vanished subdirectory used to fall
		// back to the top level, so every untouched file below it read as new.
		const home = join(scratch, "churned", ".hobo");
		mkdirSync(join(home, "durable", "code", "chats"), { recursive: true });
		for (let i = 0; i < 40; i += 1)
			writeFileSync(
				join(home, "durable", "code", "chats", `old-${i}.json`),
				"{}",
			);
		for (let i = 0; i < 200; i += 1)
			mkdirSync(join(home, "sandboxes", `run-${i}`, "a", "b"), {
				recursive: true,
			});
		const churn = spawn(process.execPath, [
			"-e",
			`const fs = require("node:fs"), p = require("node:path");
			const home = ${JSON.stringify(home)};
			const end = Date.now() + 1500;
			for (let i = 0; Date.now() < end; i += 1) {
				const run = p.join(home, "sandboxes", "run-" + (i % 200));
				fs.rmSync(run, { recursive: true, force: true });
				fs.mkdirSync(p.join(run, "a", "b"), { recursive: true });
			}`,
		]);
		const exited = new Promise((done) => churn.once("exit", done));
		let before = snapshotHomes([home]);
		const until = Date.now() + 1000;
		while (Date.now() < until) before = snapshotHomes([home]);
		await exited;
		const gained = gainedEntries(before, snapshotHomes([home]));
		expect(
			gained.filter((path) => !path.startsWith(join(home, "sandboxes"))),
		).toEqual([]);
	});
});

describe("the guard", () => {
	it("passes a run that wrote nowhere, though the homes already held entries", () => {
		// The machine's homes may hold a developer's state, or an earlier leak.
		const run = runUnderGuard("", ({ home, temp }) => {
			mkdirSync(join(home, ".hobo", "durable"), { recursive: true });
			writeFileSync(join(home, ".hobo", "durable", "old.json"), "{}");
			mkdirSync(join(temp, ".hobo"), { recursive: true });
		});
		expect(run.output).not.toMatch(/A real HoBo home changed/u);
		expect(run.status).toBe(0);
	});

	it("fails a run that added an entry under HOME's .hobo, and names it", () => {
		const run = runUnderGuard(
			`writeFileSync(join(process.env.HOME, ".hobo", "durable", "leak.json"), "{}");`,
			({ home }) => {
				mkdirSync(join(home, ".hobo", "durable"), { recursive: true });
			},
		);
		expect(run.status).toBe(1);
		expect(run.output).toContain(
			join(run.home, ".hobo", "durable", "leak.json"),
		);
		// It cannot tell who wrote: a HoBo session may have, meanwhile.
		expect(run.output.replace(/\s+/gu, " ")).toContain(
			"A real HoBo home changed while packages/code tests ran: this run, or another process during it, wrote there.",
		);
	});

	it("fails a run that overwrote a file already in HOME's .hobo, and names it", () => {
		const run = runUnderGuard(
			`writeFileSync(join(process.env.HOME, ".hobo", "durable", "chat.json"), "{\\"messages\\":[1]}");`,
			({ home }) => {
				mkdirSync(join(home, ".hobo", "durable"), { recursive: true });
				writeFileSync(join(home, ".hobo", "durable", "chat.json"), "{}");
			},
		);
		expect(run.status).toBe(1);
		expect(run.output).toMatch(/changed:/u);
		expect(run.output).toContain(
			join(run.home, ".hobo", "durable", "chat.json"),
		);
	});

	it("fails a run that wrote a file into HOME's .hobo and removed it again, and names it", () => {
		// The snapshot after the run cannot see it; the watch during it does.
		const run = runUnderGuard(
			`const leak = join(process.env.HOME, ".hobo", "durable", "brief.json");
			writeFileSync(leak, "{}");
			rmSync(leak);`,
			({ home }) => {
				mkdirSync(join(home, ".hobo", "durable"), { recursive: true });
			},
		);
		expect(run.status).toBe(1);
		expect(run.output).toMatch(/written, then removed or put back:/u);
		expect(run.output).toContain(
			join(run.home, ".hobo", "durable", "brief.json"),
		);
	});

	it("fails a run that removed a file from HOME's .hobo, and names it", () => {
		const run = runUnderGuard(
			`rmSync(join(process.env.HOME, ".hobo", "durable", "session.json"));`,
			({ home }) => {
				mkdirSync(join(home, ".hobo", "durable"), { recursive: true });
				writeFileSync(join(home, ".hobo", "durable", "session.json"), "{}");
			},
		);
		expect(run.status).toBe(1);
		expect(run.output).toMatch(/removed:/u);
		expect(run.output).toContain(
			join(run.home, ".hobo", "durable", "session.json"),
		);
	});

	it("runs against a throwaway home when the runner exports HOBO_HOME=$HOME/.hobo", () => {
		// The product's docs tell users to export exactly that. The isolation
		// must not keep it as "the runner's own home", and the guard must still
		// watch it.
		const run = runUnderGuard(
			`mkdirSync(join(process.env.HOBO_HOME, "durable"), { recursive: true });
			writeFileSync(join(process.env.HOBO_HOME, "durable", "leak.json"), "{}");
			writeFileSync(join(process.env.TMPDIR, "seen-home"), process.env.HOBO_HOME);`,
			({ home }) => {
				mkdirSync(join(home, ".hobo", "durable"), { recursive: true });
			},
			{ setupFiles: ISOLATION, env: { HOBO_HOME: "{home}/.hobo" } },
		);
		expect(run.output).not.toMatch(/A real HoBo home changed/u);
		expect(run.status).toBe(0);
		expect(existsSync(join(run.home, ".hobo", "durable", "leak.json"))).toBe(
			false,
		);
		const seen = readFileSync(join(run.temp, "seen-home"), "utf8");
		expect(seen.startsWith(join(run.temp, "hobo-test-homes-"))).toBe(true);
	});

	it("runs against a throwaway home whatever HOBO_HOME the runner exported", () => {
		// The reviewer's repro: HOBO_HOME=$HOME/.local/state/hobo was kept, and
		// the suite wrote the user's real state there.
		const run = runUnderGuard(
			`mkdirSync(join(process.env.HOBO_HOME, "durable"), { recursive: true });
			writeFileSync(join(process.env.HOBO_HOME, "durable", "leak.json"), "{}");`,
			({ home }) => {
				mkdirSync(join(home, ".local", "state", "hobo"), { recursive: true });
			},
			{
				setupFiles: ISOLATION,
				env: { HOBO_HOME: "{home}/.local/state/hobo" },
			},
		);
		expect(run.output).not.toMatch(/A real HoBo home changed/u);
		expect(run.status).toBe(0);
		expect(
			existsSync(join(run.home, ".local", "state", "hobo", "durable")),
		).toBe(false);
	});

	it("watches the HOBO_HOME the run replaced, and names a write into it", () => {
		const run = runUnderGuard(
			`writeFileSync(join("{home}", ".local", "state", "hobo", "leak.json"), "{}");`,
			({ home }) => {
				mkdirSync(join(home, ".local", "state", "hobo"), { recursive: true });
			},
			{
				setupFiles: ISOLATION,
				env: { HOBO_HOME: "{home}/.local/state/hobo" },
			},
		);
		expect(run.status).toBe(1);
		expect(run.output).toContain(
			join(run.home, ".local", "state", "hobo", "leak.json"),
		);
	});

	it("still watches the real home when a run is pointed at it on purpose", () => {
		const run = runUnderGuard(
			`writeFileSync(join(process.env.HOBO_HOME, "durable", "leak.json"), "{}");`,
			({ home }) => {
				mkdirSync(join(home, ".hobo", "durable"), { recursive: true });
			},
			{ setupFiles: ISOLATION, env: { HOBO_TEST_HOBO_HOME: "{home}/.hobo" } },
		);
		expect(run.status).toBe(1);
		expect(run.output).toContain(
			join(run.home, ".hobo", "durable", "leak.json"),
		);
	});

	it("fails a run that created the temp dir's .hobo, and names it", () => {
		// `<os.tmpdir()>/.hobo` was the old fallback for an environment with no HOME.
		const run = runUnderGuard(
			`mkdirSync(join(process.env.TMPDIR, ".hobo", "durable"), { recursive: true });`,
		);
		expect(run.status).toBe(1);
		expect(run.output).toContain(join(run.temp, ".hobo"));
		expect(run.output).toContain(join(run.temp, ".hobo", "durable"));
	});
});
