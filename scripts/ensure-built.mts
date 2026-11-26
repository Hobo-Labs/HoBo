/**
 * `pretest` shim: guarantee a package's build output exists before its tests
 * run, without paying for it twice.
 *
 * Package `pretest` hooks used to be `pnpm run build` (and, for 19 packages, a
 * chain of `pnpm --filter <dep> build` calls). Those run *outside* turbo, so
 * they never hit the cache: a full sweep paid ~150 cold `tsc` invocations,
 * every one of them redundant with the `build` task turbo had already run and
 * cached.
 *
 * Turbo sets `TURBO_HASH` in every task process (verified under
 * `envMode: "strict"`), and `tasks.test.dependsOn` includes `build`, so inside
 * turbo the guarantee already holds and this exits immediately. Outside turbo
 * — `pnpm --filter <pkg> test`, the stage-gate workflow steps — it delegates to
 * turbo so the build is *cached* rather than re-run.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

if (process.env["TURBO_HASH"]) {
	process.exit(0);
}

// SAFETY: assertion to `.parse(readFileSync("package.json", "utf8")) as { name?: string; }; co` is required at this boundary.
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
	name?: string;
};
const name = manifest.name;
if (!name) {
	console.error("ensure-built: package.json has no name; cannot build");
	process.exit(1);
}

const result = spawnSync(
	"pnpm",
	["exec", "turbo", "run", "build", `--filter=${name}`, "--concurrency=100%"],
	{ stdio: "inherit", shell: false, cwd: process.cwd() },
);
process.exit(result.status ?? 1);
