import {
	assertCatalogStarter as assertPatternStarter,
	type CliStarterAlias,
	catalogStarterId as patternStarterId,
	renderCliStarterFiles,
} from "@hobo/patterns";

import type { ParsedTemplateId, ProjectName } from "../types/scaffold.js";

export function catalogStarterId(template: ParsedTemplateId): string {
	// SAFETY: `return patternStarterId(template as CliStarterAlias);` is required at this I/O or test boundary.
	return patternStarterId(template as CliStarterAlias);
}

export function assertCatalogStarter(template: ParsedTemplateId): void {
	// SAFETY: `assertPatternStarter(template as CliStarterAlias);` is required at this I/O or test boundary.
	assertPatternStarter(template as CliStarterAlias);
}

export function buildProjectFiles(input: {
	readonly name: ProjectName;
	readonly template: ParsedTemplateId;
}): Map<string, string> {
	return renderCliStarterFiles({
		name: input.name,
		// SAFETY: `template: input.template as CliStarterAlias,` is required at this I/O or test boundary.
		template: input.template as CliStarterAlias,
	});
}
