import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function findCaseCollisions(paths: readonly string[]) {
	const groups = new Map<string, string[]>();
	for (const candidate of paths) {
		const normalized = candidate.replaceAll("\\", "/");
		const key = normalized.toLowerCase();
		const group = groups.get(key);
		if (group) {
			group.push(normalized);
		} else {
			groups.set(key, [normalized]);
		}
	}

	return [...groups.values()]
		.filter((group) => group.length > 1)
		.map((group) => group.sort((left, right) => left.localeCompare(right)));
}

function main() {
	const result = spawnSync("git", ["ls-files"], {
		encoding: "utf8",
		shell: false,
		// monorepo tracked-file list exceeds Node's default 1 MiB maxBuffer
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		process.stderr.write(
			result.stderr ||
				result.error?.message ||
				"Unable to read tracked files with git ls-files.\n",
		);
		process.exit(result.status ?? 1);
	}

	const collisions = findCaseCollisions(
		result.stdout.split(/\r?\n/u).filter(Boolean),
	);
	if (collisions.length === 0) {
		console.log("case collision check ok");
		return;
	}

	console.error("Case-colliding tracked paths found:");
	for (const group of collisions) {
		console.error(`- ${group.join("\n  ")}`);
	}
	process.exit(1);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main();
}
