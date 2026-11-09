#!/usr/bin/env node
/**
 * hobo-code entry (package bin).
 *
 * Prefer this over calling dist/bin directly in a monorepo: edits land in
 * `src/`, the published binary is compiled `dist/`. When dist is missing or
 * older than src, try `tsc` — but never block the CLI on an unrelated type
 * error. Fall back to `src/bin/hobo-code.ts` via tsx so `hobo-code agents`
 * stays runnable while dist is dirty.
 *
 * Workspace deps that export only `dist/` (e.g. `@hobo/stations`) can go
 * stale after a fast-forward while `@hobo/code` dist stays fresh. Rebuild
 * those with `tsc -p` only — never `pnpm run build` / prebuild fan-out.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forwardSignal, launcherSignals } from "./launcher-signals.mjs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distCli = join(pkgRoot, "dist", "cli.js");
const distBin = join(pkgRoot, "dist", "bin", "hobo-code.js");
const srcBin = join(pkgRoot, "src", "bin", "hobo-code.ts");
const srcRoot = join(pkgRoot, "src");

function maxSrcMtime(dir) {
	let max = 0;
	/** @param {string} d */
	const walk = (d) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const p = join(d, ent.name);
			if (ent.isDirectory()) {
				if (ent.name === "node_modules" || ent.name === "dist") continue;
				walk(p);
			} else if (/\.(ts|mts|tsx|cts)$/.test(ent.name)) {
				try {
					max = Math.max(max, statSync(p).mtimeMs);
				} catch {
					/* ignore */
				}
			}
		}
	};
	walk(dir);
	return max;
}

function distIsStale() {
	if (!existsSync(distCli) || !existsSync(distBin)) return true;
	const distM = statSync(distCli).mtimeMs;
	// 1s slack for filesystem mtime granularity
	return maxSrcMtime(srcRoot) > distM + 1000;
}

function tscPath() {
	if (
		Object.prototype.toString.call(process.env.HOBO_CODE_TSC) ===
			"[object String]" &&
		process.env.HOBO_CODE_TSC
	) {
		return process.env.HOBO_CODE_TSC;
	}
	const local = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
	if (existsSync(local)) return local;
	return join(pkgRoot, "..", "..", "node_modules", "typescript", "bin", "tsc");
}

function resolveStationsRoot() {
	try {
		const require = createRequire(join(pkgRoot, "package.json"));
		const resolved = require.resolve("@hobo/stations");
		return join(dirname(resolved), "..");
	} catch {
		const linked = join(pkgRoot, "node_modules", "@hobo", "stations");
		return existsSync(linked) ? linked : null;
	}
}

/** @param {string} p */
function mtimeOrNull(p) {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * `@hobo/stations` package.json exports only dist/. After a pull that lands
 * new src exports, Node still loads the old dist and fails on named imports
 * (e.g. stationCapability). Detect that and tsc the package in-place.
 */
function stationsDistIsStale(stationsRoot) {
	const srcIndex = join(stationsRoot, "src", "index.ts");
	const distIndex = join(stationsRoot, "dist", "index.js");
	if (!existsSync(srcIndex)) return false;
	if (!existsSync(distIndex)) return true;
	const srcText = readFileSync(srcIndex, "utf8");
	const distText = readFileSync(distIndex, "utf8");
	const required = ["stationCapability", "persistStationCapabilityManifest"];
	for (const name of required) {
		if (srcText.includes(name) && !distText.includes(name)) return true;
	}
	const srcM = maxSrcMtime(join(stationsRoot, "src"));
	const distM = mtimeOrNull(distIndex);
	return distM != null && srcM > distM + 1000;
}

function tryRebuildStationsDist() {
	if (process.env.HOBO_CODE_SKIP_STATIONS_REBUILD === "1") return;
	const stationsRoot = resolveStationsRoot();
	if (!stationsRoot || !stationsDistIsStale(stationsRoot)) return;
	process.stderr.write(
		"hobo-code: @hobo/stations dist is stale — tsc stations only…\n",
	);
	const tsc = tscPath();
	const build = existsSync(tsc)
		? spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
				cwd: stationsRoot,
				stdio: "inherit",
				env: process.env,
			})
		: spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
				cwd: stationsRoot,
				stdio: "inherit",
				env: process.env,
				shell: process.platform === "win32",
			});
	if ((build.status ?? 1) !== 0) {
		process.stderr.write(
			"hobo-code: stations tsc failed — run: pnpm --filter @hobo/stations exec tsc -p tsconfig.json\n",
		);
	}
}

function tryRebuildDist() {
	process.stderr.write(
		"hobo-code: dist is stale (src newer than dist) — tsc @hobo/code only…\n",
	);
	const tsc = tscPath();
	const build = existsSync(tsc)
		? spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
				cwd: pkgRoot,
				stdio: "inherit",
				env: process.env,
			})
		: spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
				cwd: pkgRoot,
				stdio: "inherit",
				env: process.env,
				shell: process.platform === "win32",
			});
	if ((build.status ?? 1) === 0) {
		try {
			chmodSync(distBin, 0o755);
			chmodSync(join(pkgRoot, "bin", "hobo-code.mjs"), 0o755);
		} catch {
			/* postbuild chmod is best-effort after a successful tsc */
		}
		return true;
	}
	process.stderr.write(
		"hobo-code: tsc failed — running src/ via tsx (dist not required to test)\n",
	);
	return false;
}

/**
 * Except on Windows the child runs in a session of its own, so the terminal's
 * hangup never reaches it, nor does a signal sent to hobo-code: this launcher
 * passes on every signal that ends hobo-code (below). Its IPC channel covers
 * the one end that passes nothing on, the launcher killed outright: the
 * channel closes, and the child takes that as a hangup
 * (`src/launcher-hangup.ts`). On Windows the child shares the console.
 */
const detached = process.platform !== "win32";
const childStdio = ["inherit", "inherit", "inherit", "ipc"];

function runFromSource() {
	if (!existsSync(srcBin)) {
		process.stderr.write(
			"hobo-code: missing src/bin/hobo-code.ts — cannot fall back from stale dist\n",
		);
		process.exit(1);
	}
	return spawn(
		process.execPath,
		["--import", "tsx", srcBin, ...process.argv.slice(2)],
		{
			stdio: childStdio,
			env: process.env,
			cwd: pkgRoot,
			detached,
		},
	);
}

const forceSource = process.env.HOBO_CODE_FROM_SOURCE === "1";
const skipRebuild = process.env.HOBO_CODE_SKIP_STALE_REBUILD === "1";
const wantRebuild =
	!skipRebuild &&
	(process.env.HOBO_CODE_FORCE_STALE_REBUILD === "1" || distIsStale());

if (!skipRebuild) {
	tryRebuildStationsDist();
}

let useSource = forceSource;
if (!useSource && wantRebuild) {
	const rebuilt = tryRebuildDist();
	useSource = !rebuilt;
}

if (!useSource && !existsSync(distBin)) {
	if (existsSync(srcBin)) {
		process.stderr.write(
			"hobo-code: missing dist/bin/hobo-code.js — running src/ via tsx\n",
		);
		useSource = true;
	} else {
		process.stderr.write(
			"hobo-code: missing dist/bin/hobo-code.js — run: pnpm --filter @hobo/code build\n",
		);
		process.exit(1);
	}
}

const run = useSource
	? runFromSource()
	: spawn(process.execPath, [distBin, ...process.argv.slice(2)], {
			stdio: childStdio,
			env: process.env,
			detached,
		});
// Except on Windows, every signal that ends hobo-code goes on to the child,
// the closing terminal's SIGHUP included, and hobo-code waits for the child to
// end: the terminal is handed back once the child has restored it. On Windows
// nothing is passed on (launcher-signals.mjs says why), and hobo-code only
// waits for the child.
const signals = launcherSignals(process.platform);
const onSignal = signals.forward
	? (signal) => forwardSignal(run, signal)
	: () => {};
for (const signal of signals.listen) process.on(signal, onSignal);
const result = await new Promise((resolve) => {
	run.once("error", (error) => resolve({ error }));
	run.once("exit", (status, signal) => resolve({ status, signal }));
});
for (const signal of signals.listen) process.off(signal, onSignal);
if (result.error) process.stderr.write(`hobo-code: ${result.error.message}\n`);
// A child ended by signal n: 128+n, as a shell reports it.
process.exitCode =
	result.status ??
	(result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1);
