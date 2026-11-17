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

export function isPathIdentifier(value: string): boolean {
	return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}
