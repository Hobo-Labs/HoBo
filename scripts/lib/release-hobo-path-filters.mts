import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ReleaseHoboPathFilterEvent = "pull_request" | "merge_group";

export function parseReleaseHoboPathFilters(
	workflowYaml: string,
	event: ReleaseHoboPathFilterEvent,
): string[] {
	const marker = `${event}:`;
	const start = workflowYaml.indexOf(marker);
	if (start < 0) {
		throw new Error(`release-hobo workflow missing ${event} trigger`);
	}
	const block = workflowYaml.slice(start);
	const pathsIdx = block.indexOf("\n    paths:");
	if (pathsIdx < 0) {
		throw new Error(`release-hobo workflow missing ${event}.paths`);
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
		throw new Error(`release-hobo ${event}.paths is empty`);
	}
	return filters;
}

export function parseReleaseHoboPullRequestPathFilters(
	workflowYaml: string,
): string[] {
	return parseReleaseHoboPathFilters(workflowYaml, "pull_request");
}

export function parseReleaseHoboMergeGroupPathFilters(
	workflowYaml: string,
): string[] {
	return parseReleaseHoboPathFilters(workflowYaml, "merge_group");
}

export function loadReleaseHoboPullRequestPathFilters(
	repoRoot: string,
): string[] {
	const workflowPath = join(repoRoot, ".github/workflows/release-hobo.yml");
	return parseReleaseHoboPullRequestPathFilters(
		readFileSync(workflowPath, "utf8"),
	);
}

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
