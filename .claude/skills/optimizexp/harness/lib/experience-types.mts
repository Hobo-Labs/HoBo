/**
 * Formal OptimizeXP experience-type binding for personas (and feature tags).
 *
 * Canonical frontmatter field on personas:
 *   experiences: [ux, dx, ax]   # non-empty subset; order free; normalized to ux→dx→ax
 *
 * Accepted alias (same semantics):
 *   experienceTypes: [ux, dx]
 *
 * A persona participates in a run only when
 *   persona.experiences ∩ runExperiences ≠ ∅
 */

/** Closed enum of OptimizeXP experience tracks. */
export const EXPERIENCE_TYPES = ["ux", "dx", "ax"] as const;

export type ExperienceType = (typeof EXPERIENCE_TYPES)[number];

export function isExperienceType(v: string): v is ExperienceType {
	return (EXPERIENCE_TYPES as readonly string[]).includes(v);
}

/** Canonical display order for normalized lists. */
export const EXPERIENCE_ORDER: Record<ExperienceType, number> = {
	ux: 0,
	dx: 1,
	ax: 2,
};

export type ParseExperiencesResult = {
	/** Normalized unique list in ux → dx → ax order */
	ok: ExperienceType[];
	/** Human-readable validation problems (empty when ok is usable) */
	problems: string[];
	/** Which frontmatter key supplied the value */
	source: "experiences" | "experienceTypes" | "none";
	/** Raw tokens before normalization (invalid included) */
	raw: string[];
};

/**
 * Parse experience types from persona (or feature) YAML frontmatter text.
 * Prefers `experiences:`; falls back to alias `experienceTypes:`.
 *
 * Accepts:
 *   experiences: [ux, dx]
 *   experiences: [ux,dx,ax]
 *   experiences: ux          # single bare token (normalized to list)
 *   experienceTypes: [ax]
 */
export function parseExperienceTypesFromYaml(yaml: string): ParseExperiencesResult {
	const listHit =
		yaml.match(/^experiences:\s*\[([^\]]*)\]\s*$/m) ||
		yaml.match(/^experienceTypes:\s*\[([^\]]*)\]\s*$/m);
	const bareHit =
		!listHit &&
		(yaml.match(/^experiences:\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*$/m) ||
			yaml.match(/^experienceTypes:\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*$/m));

	let source: ParseExperiencesResult["source"] = "none";
	let raw: string[] = [];

	if (listHit) {
		const keyLine = yaml.match(/^(experiences|experienceTypes):\s*\[/m)?.[1];
		source = keyLine === "experienceTypes" ? "experienceTypes" : "experiences";
		raw = listHit[1]!
			.split(",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean)
			.map((s) => s.toLowerCase());
	} else if (bareHit) {
		const keyLine = yaml.match(/^(experiences|experienceTypes):\s*\S/m)?.[1];
		source = keyLine === "experienceTypes" ? "experienceTypes" : "experiences";
		raw = [bareHit[1]!.trim().toLowerCase()];
	}

	return normalizeExperienceTokens(raw, source);
}

/**
 * Normalize free tokens into a formal experience set.
 */
export function normalizeExperienceTokens(
	raw: string[],
	source: ParseExperiencesResult["source"] = "experiences",
): ParseExperiencesResult {
	const problems: string[] = [];
	const seen = new Set<ExperienceType>();
	const invalid: string[] = [];

	for (const t of raw) {
		const tok = t.trim().toLowerCase();
		if (!tok) continue;
		if (isExperienceType(tok)) {
			seen.add(tok);
		} else {
			invalid.push(tok);
		}
	}

	if (source === "none" || raw.length === 0) {
		problems.push(
			"frontmatter.experiences is required: non-empty list of ux, dx, and/or ax (alias: experienceTypes)",
		);
	}
	for (const inv of invalid) {
		problems.push(
			`frontmatter.experiences invalid token "${inv}" — allowed: ux, dx, ax`,
		);
	}
	if (raw.length > 0 && seen.size === 0) {
		problems.push(
			"frontmatter.experiences has no valid experience types after filtering",
		);
	}

	const ok = [...seen].sort(
		(a, b) => EXPERIENCE_ORDER[a] - EXPERIENCE_ORDER[b],
	);

	return { ok, problems, source, raw };
}

/** Format for frontmatter write: `experiences: [ux, dx]` */
export function formatExperiencesFrontmatter(
	types: readonly ExperienceType[],
): string {
	const normalized = normalizeExperienceTokens([...types], "experiences").ok;
	return `experiences: [${normalized.join(", ")}]`;
}

/**
 * Whether a persona is in scope for a run's experience set.
 * Empty persona experiences → never in scope (invalid persona).
 * Empty run experiences → treat as all three (caller usually expands defaults).
 */
export function personaMatchesExperiences(
	personaExperiences: readonly string[],
	runExperiences: readonly string[],
): boolean {
	const p = new Set(
		personaExperiences.filter((e): e is ExperienceType => isExperienceType(e)),
	);
	if (p.size === 0) return false;
	const run =
		runExperiences.length === 0
			? EXPERIENCE_TYPES
			: runExperiences.filter((e): e is ExperienceType => isExperienceType(e));
	return run.some((e) => p.has(e));
}

/** Expand CLI/run experience flags to a formal set (default all three). */
export function resolveRunExperiences(
	raw: string | string[] | undefined,
): ExperienceType[] {
	if (raw == null || (Array.isArray(raw) && raw.length === 0) || raw === "") {
		return [...EXPERIENCE_TYPES];
	}
	const parts = (Array.isArray(raw) ? raw : [raw])
		.flatMap((s) => s.split(/[,\s]+/))
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const { ok, problems } = normalizeExperienceTokens(parts, "experiences");
	if (problems.length && ok.length === 0) {
		// fall back to all if completely garbage — callers may re-validate
		return [...EXPERIENCE_TYPES];
	}
	return ok.length ? ok : [...EXPERIENCE_TYPES];
}
