/** Normalize Gherkin scenario titles to filesystem-safe slugs. */
export function scenarioSlug(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/['"]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 120);
}
