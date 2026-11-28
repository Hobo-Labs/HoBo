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

export function parseReleasePagesPathFilters(workflowYaml: string): string[] {
	const filters: string[] = [];
	for (const key of [
		"RELEASE_PAGES_SPARSE_PATHS",
		"RELEASE_PAGES_MATERIALIZE_PATHS",
	]) {
		const marker = `  ${key}: |`;
		const start = workflowYaml.indexOf(`\n${marker}\n`);
		if (start < 0) return ["**"];
		const after = workflowYaml.slice(start + marker.length + 2);
		const entries: string[] = [];
		for (const line of after.split("\n")) {
			if (!line.startsWith("    ")) break;
			const entry = line.trim();
			if (!entry) continue;
			if (
				!/^[A-Za-z0-9._/-]+$/u.test(entry) ||
				entry.startsWith("/") ||
				entry.split("/").includes("..")
			)
				return ["**"];
			entries.push(`${entry}/**`);
		}
		if (entries.length === 0) return ["**"];
		filters.push(...entries);
	}
	try {
		return [
			...parseReleaseHoboPullRequestPathFilters(workflowYaml),
			...filters,
		];
	} catch {
		return ["**"];
	}
}

export function loadReleasePagesPathFilters(repoRoot: string): string[] {
	const workflowYaml = readFileSync(
		join(repoRoot, ".github/workflows/release-hobo.yml"),
		"utf8",
	);
	return parseReleasePagesPathFilters(workflowYaml);
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
