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
