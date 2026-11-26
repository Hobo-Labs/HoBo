// Repository search wrapper: prefer tgrep (trigram-indexed exact/regex search)
// when it is installed, otherwise fall back to ripgrep. Replaces an `sh -c`
// one-liner so the same `pnpm run search <args>` works in Windows shells where
// `sh` is unavailable. All arguments are forwarded verbatim to the tool.
import { spawnSync } from "node:child_process";

function resolveBin(bin: string): string | undefined {
	const locator = process.platform === "win32" ? "where" : "which";
	const probe = spawnSync(locator, [bin], { encoding: "utf8" });
	if (probe.status !== 0) return undefined;
	// `where` can list several matches; take the first line.
	return probe.stdout.split(/\r?\n/u)[0]?.trim() || undefined;
}

const tool = resolveBin("tgrep") ?? resolveBin("rg");
if (!tool) {
	console.error("search: neither tgrep nor rg is installed.");
	process.exit(127);
}

const result = spawnSync(tool, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
	console.error(`search: failed to run ${tool}: ${result.error.message}`);
	process.exit(127);
}

process.exit(result.status ?? 1);
