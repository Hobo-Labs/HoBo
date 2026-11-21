/** Path filters aligned with `.github/workflows/release-hobo.yml` pull_request.paths. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function parseReleaseHoboPullRequestPathFilters(
	workflowYaml: string,
): string[] {
	const marker = "pull_request:";
	const start = workflowYaml.indexOf(marker);
	if (start < 0) {
		throw new Error("release-hobo workflow missing pull_request trigger");
	}
	const block = workflowYaml.slice(start);
	const pathsIdx = block.indexOf("\n    paths:");
	if (pathsIdx < 0) {
		throw new Error("release-hobo workflow missing pull_request.paths");
	}
	const afterPaths = block.slice(pathsIdx + "\n    paths:".length);
	const filters: string[] = [];
	for (const line of afterPaths.split("\n")) {
		if (!line.startsWith("      - ")) {
			if (filters.length > 0) break;
			continue;
		}
		filters.push(line.slice("      - ".length).replace(/^"|"$/g, "").trim());
	}
	if (filters.length === 0) {
		throw new Error("release-hobo pull_request.paths is empty");
	}
	return filters;
}

export function loadReleaseHoboPullRequestPathFilters(
	repoRoot: string,
): string[] {
	const workflowPath = join(repoRoot, ".github/workflows/release-hobo.yml");
	return parseReleaseHoboPullRequestPathFilters(
		readFileSync(workflowPath, "utf8"),
	);
}

/** Match GitHub workflow path filter globs (no leading `./`). */
export function pathMatchesReleaseHoboFilter(
	filePath: string,
	filter: string,
): boolean {
	const file = filePath.replace(/^\.\//, "").replace(/\\/g, "/");
	if (filter.endsWith("/**")) {
		const prefix = filter.slice(0, -3);
		return file === prefix || file.startsWith(`${prefix}/`);
	}
	if (filter.includes("*")) {
		const escaped = filter
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*/g, "<<GLOBSTAR>>")
			.replace(/\*/g, "[^/]*")
			.replace(/<<GLOBSTAR>>/g, ".*");
		return new RegExp(`^${escaped}$`).test(file);
	}
	return file === filter;
}

export function anyPathMatchesReleaseHoboFilters(
	changedPaths: readonly string[],
	filters: readonly string[],
): boolean {
	return changedPaths.some((file) =>
		filters.some((filter) => pathMatchesReleaseHoboFilter(file, filter)),
	);
}
