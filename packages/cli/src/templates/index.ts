import {
	assertCatalogStarter as assertPatternStarter,
	type CliStarterAlias,
	catalogStarterId as patternStarterId,
	renderCliStarterFiles,
} from "@hobo/patterns";

import type { ParsedTemplateId, ProjectName } from "../types/scaffold.js";

export function catalogStarterId(template: ParsedTemplateId): string {
	return patternStarterId(template as CliStarterAlias);
}

export function assertCatalogStarter(template: ParsedTemplateId): void {
	assertPatternStarter(template as CliStarterAlias);
}

export function buildProjectFiles(input: {
	readonly name: ProjectName;
	readonly template: ParsedTemplateId;
}): Map<string, string> {
	return renderCliStarterFiles({
		name: input.name,
		template: input.template as CliStarterAlias,
	});
}
