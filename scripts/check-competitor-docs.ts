import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Validates the competitor corpus against docs/competitors/metadata-contract.md,
 * and regenerates the derived matrix + freshness ledger with --fix. What it
 * writes into the repo never depends on the day it runs; how old a capture is
 * is read off the clock at check time and only reported (see `staleCaptures`).
 *
 * Deliberately dependency-free: the front matter we own is a fixed, flat shape,
 * so a scoped parser beats adding a YAML runtime dependency for docs linting.
 */

export type Problem = { file: string; line: number; message: string };

export const CATEGORIES = [
	"platform-orchestrators",
	"portable-application-models",
	"cloud-application-platforms",
	"developer-portals-idps",
	"infrastructure-from-code",
	"runtime-substrates",
	"hybrid-multicloud-enterprise",
	"self-hosted-paas",
	"agentic-infrastructure",
	"backend-data-platforms",
	"delivery-release-gitops",
	"finops-governance-placement",
	"identity-networking-delivery",
] as const;

export const DIRECTNESS = [
	"direct",
	"overlapping",
	"adjacent",
	"complementary",
] as const;

export const POSTURES = [
	"displace",
	"integrate",
	"adopt",
	"provider-target",
	"render-target",
	"borrow",
	"benchmark",
	"standard",
] as const;

export const EVIDENCE = [
	"implemented",
	"proof",
	"design-only",
	"not-present",
	"mixed",
] as const;

export const STATUSES = [
	"active",
	"renamed",
	"acquired",
	"abandoned",
	"archived",
] as const;

export const SURFACES = [
	"authoring",
	"app-graph",
	"typed-contracts",
	"wiring",
	"environments",
	"provider-matching",
	"runtime-portability",
	"reconciliation",
	"delivery",
	"governance",
	"identity-secrets",
	"observability",
	"finops",
	"agent-surface",
	"replay-migration",
	"extensibility",
	"ecosystem",
] as const;

/** Section headings every canonical capture must carry (research contract §1-12). */
export const REQUIRED_SECTIONS = [
	"What it is",
	"Core primitives",
	"Feature surface",
	"Architecture",
	"How it competes with HoBo",
	"Primitive mapping",
	"Where <competitor> is stronger",
	"Where HoBo is stronger",
	"Adversarial critique",
	"Better-together",
	"Threats and lessons",
	"Sources",
] as const;

/** Files under docs/competitors/ that are navigation or synthesis, not captures. */
const NON_CAPTURE = new Set([
	"index.md",
	"matrix.md",
	"gap-analysis.md",
	"metadata-contract.md",
]);

const STALE_AFTER_DAYS = 180;
const marker = (name: string, edge: "BEGIN" | "END") =>
	`<!-- ${edge} GENERATED: ${name} -->`;

export type Competitor = {
	slug: string;
	name: string;
	aliases: string[];
	primary_category: string;
	categories: string[];
	directness: string;
	role: string;
	posture: string[];
	hobo_surface: string[];
	evidence: string;
	status: string;
	research_date: string;
	sources: string[];
	/** "v1" once the capture has been rewritten to the twelve-section research contract. */
	contract?: string | undefined;
	file: string;
};

type CompetitorField = string | string[];
type Raw = {
	slug?: CompetitorField;
	name?: CompetitorField;
	primary_category?: CompetitorField;
	categories?: CompetitorField;
	directness?: CompetitorField;
	role?: CompetitorField;
	posture?: CompetitorField;
	hobo_surface?: CompetitorField;
	evidence?: CompetitorField;
	status?: CompetitorField;
	research_date?: CompetitorField;
	sources?: CompetitorField;
	contract?: CompetitorField;
	aliases?: CompetitorField;
};

function setRaw(raw: Raw, key: string, value: CompetitorField): void {
	switch (key) {
		case "slug":
		case "name":
		case "primary_category":
		case "categories":
		case "directness":
		case "role":
		case "posture":
		case "hobo_surface":
		case "evidence":
		case "status":
		case "research_date":
		case "sources":
		case "contract":
		case "aliases":
			raw[key] = value;
			return;
		default:
			return;
	}
}

function getRaw(raw: Raw, key: string): CompetitorField | undefined {
	switch (key) {
		case "slug":
			return raw.slug;
		case "name":
			return raw.name;
		case "primary_category":
			return raw.primary_category;
		case "categories":
			return raw.categories;
		case "directness":
			return raw.directness;
		case "role":
			return raw.role;
		case "posture":
			return raw.posture;
		case "hobo_surface":
			return raw.hobo_surface;
		case "evidence":
			return raw.evidence;
		case "status":
			return raw.status;
		case "research_date":
			return raw.research_date;
		case "sources":
			return raw.sources;
		case "contract":
			return raw.contract;
		case "aliases":
			return raw.aliases;
		default:
			return undefined;
	}
}

export function frontMatter(
	text: string,
): { body: string; raw: Raw } | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) return undefined;
	return { body: text.slice(match[0].length), raw: parseBlock(match[1] ?? "") };
}

/**
 * Parses the `competitor:` mapping out of a front-matter block: scalars,
 * inline `[a, b]` sequences, and `- item` block sequences. Anything else is
 * left alone — other front-matter keys are not ours to interpret.
 */
export function parseBlock(source: string): Raw {
	const lines = source.split(/\r?\n/);
	const start = lines.findIndex((line) => /^competitor:\s*$/.test(line));
	if (start === -1) return {};
	const raw: Raw = {};
	let key: string | undefined;
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === "") continue;
		if (!/^\s/.test(line)) break; // dedent: end of the competitor mapping
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && key) {
			// Only a key opened as an empty sequence (`sources:` with nothing on
			// the line) accumulates items. A `- item` under a *scalar* key is
			// malformed input, and blindly pushing crashed the whole gate with
			// `raw[key].push is not a function` — a TypeError instead of a
			// reported problem. The scalar stands and the stray item is dropped;
			// the required-field checks downstream report anything genuinely
			// missing, which is where a parse error belongs.
			const current = getRaw(raw, key);
			if (Array.isArray(current)) current.push(unquote(item[1] ?? ""));
			continue;
		}
		const pair = /^\s+([a-z_]+):\s*(.*)$/.exec(line);
		if (!pair) continue;
		const nextKey = pair[1];
		if (nextKey === undefined) continue;
		key = nextKey;
		const value = (pair[2] ?? "").trim();
		if (value === "") setRaw(raw, key, []);
		else if (value.startsWith("[") && value.endsWith("]"))
			setRaw(
				raw,
				key,
				value
					.slice(1, -1)
					.split(",")
					.map((entry) => unquote(entry))
					.filter(Boolean),
			);
		else setRaw(raw, key, unquote(value));
	}
	return raw;
}

function unquote(value: string) {
	const trimmed = value.trim();
	return /^(['"])([\s\S]*)\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function listFiles(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.endsWith(".md")).sort();
}

function lineOf(text: string, needle: string) {
	const index = text.indexOf(needle);
	if (index === -1) return 1;
	return text.slice(0, index).split(/\r?\n/).length;
}

function str(value: string | string[] | undefined) {
	return Array.isArray(value) ? undefined : value;
}

function arr(value: string | string[] | undefined) {
	if (Array.isArray(value)) return value;
	return value !== undefined && value !== "" ? [value] : undefined;
}

function parseCompetitor(
	file: string,
	raw: Raw,
	problems: Problem[],
	text: string,
): Competitor | undefined {
	const at = lineOf(text, "competitor:");
	const push = (message: string) => problems.push({ file, line: at, message });
	const slug = str(raw.slug);
	const name = str(raw.name);
	const primary = str(raw.primary_category);
	const categories = arr(raw.categories);
	const directness = str(raw.directness);
	const role = str(raw.role);
	const posture = arr(raw.posture);
	const surfaces = arr(raw.hobo_surface);
	const evidence = str(raw.evidence);
	const status = str(raw.status);
	const researchDate = str(raw.research_date);
	const sources = arr(raw.sources);
	const contract = str(raw.contract);

	let ok = true;
	const require_ = (value: string | string[] | undefined, field: string) => {
		if (value === undefined || (Array.isArray(value) && value.length === 0)) {
			push(`competitor.${field} is required`);
			ok = false;
			return false;
		}
		return true;
	};
	require_(slug, "slug");
	require_(name, "name");
	require_(primary, "primary_category");
	require_(categories, "categories");
	require_(directness, "directness");
	require_(role, "role");
	require_(posture, "posture");
	require_(surfaces, "hobo_surface");
	require_(evidence, "evidence");
	require_(status, "status");
	require_(researchDate, "research_date");
	require_(sources, "sources");
	if (!ok) return undefined;

	const basename = path.basename(file, ".md");
	if (slug !== basename)
		push(`competitor.slug "${slug}" must match the filename "${basename}"`);
	// SAFETY: assertion to `as string)) ` is required at this boundary.
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug as string))
		push(`competitor.slug "${slug}" is not a valid slug`);

	const enumCheck = (
		values: string[],
		allowed: readonly string[],
		field: string,
	) => {
		for (const value of values)
			if (!allowed.includes(value))
				push(
					`competitor.${field} "${value}" is not one of: ${allowed.join(", ")}`,
				);
	};
	// SAFETY: assertion to `ories as string[], CAT` is required at this boundary.
	enumCheck(categories as string[], CATEGORIES, "categories");
	// SAFETY: assertion to `ry as string], CA` is required at this boundary.
	enumCheck([primary as string], CATEGORIES, "primary_category");
	// SAFETY: assertion to `tness as string], DI` is required at this boundary.
	enumCheck([directness as string], DIRECTNESS, "directness");
	// SAFETY: assertion to `re as string[], POS` is required at this boundary.
	enumCheck(posture as string[], POSTURES, "posture");
	// SAFETY: assertion to `ces as string[], SUR` is required at this boundary.
	enumCheck(surfaces as string[], SURFACES, "hobo_surface");
	// SAFETY: assertion to `nce as string], EV` is required at this boundary.
	enumCheck([evidence as string], EVIDENCE, "evidence");
	// SAFETY: assertion to `s as string], ST` is required at this boundary.
	enumCheck([status as string], STATUSES, "status");

	// SAFETY: assertion to `ry as string)) ` is required at this boundary.
	if (!(categories as string[]).includes(primary as string))
		push(
			`competitor.primary_category "${primary}" must also appear in categories`,
		);
	// SAFETY: assertion to `ories as string[]).len` is required at this boundary.
	if (new Set(categories as string[]).size !== (categories as string[]).length)
		push("competitor.categories contains duplicates");

	// SAFETY: assertion to `rchDate as string)) ` is required at this boundary.
	if (!/^\d{4}-\d{2}-\d{2}$/.test(researchDate as string))
		push(`competitor.research_date "${researchDate}" must be YYYY-MM-DD`);
	else if (Date.parse(`${researchDate}T00:00:00Z`) > Date.now())
		push(`competitor.research_date "${researchDate}" is in the future`);

	// SAFETY: assertion to `es as string[]) i` is required at this boundary.
	for (const source of sources as string[])
		if (!source.startsWith("https://"))
			push(`competitor.sources entry "${source}" must be an https:// URL`);

	if (contract !== undefined && contract !== "v1")
		push(`competitor.contract "${contract}" must be "v1" when present`);

	return {
		// SAFETY: assertion to `as string, /` is required at this boundary.
		slug: slug as string,
		// SAFETY: assertion to `as string, a` is required at this boundary.
		name: name as string,
		aliases: arr(raw.aliases) ?? [],
		// SAFETY: assertion to `ry as string, /` is required at this boundary.
		primary_category: primary as string,
		// SAFETY: assertion to `ories as string[], /` is required at this boundary.
		categories: categories as string[],
		// SAFETY: assertion to `tness as string, /` is required at this boundary.
		directness: directness as string,
		// SAFETY: assertion to `as string, /` is required at this boundary.
		role: role as string,
		// SAFETY: assertion to `re as string[], /` is required at this boundary.
		posture: posture as string[],
		// SAFETY: assertion to `ces as string[], /` is required at this boundary.
		hobo_surface: surfaces as string[],
		// SAFETY: assertion to `nce as string, /` is required at this boundary.
		evidence: evidence as string,
		// SAFETY: assertion to `s as string, /` is required at this boundary.
		status: status as string,
		// SAFETY: assertion to `rchDate as string, /` is required at this boundary.
		research_date: researchDate as string,
		// SAFETY: assertion to `es as string[], c` is required at this boundary.
		sources: sources as string[],
		contract,
		file,
	};
}

function checkSections(
	competitor: Competitor,
	body: string,
	problems: Problem[],
) {
	const headings = body
		.split(/\r?\n/)
		.filter((line) => /^#{2,3}\s/.test(line))
		.map((line) => line.replace(/^#+\s*/, "").toLowerCase());
	for (const section of REQUIRED_SECTIONS) {
		// The competitor-strengths heading names the product, and captures shorten
		// long product names in headings ("Harness" for "Harness Platform"), so match
		// the shape rather than the exact name — but never let HoBo's own heading
		// satisfy it.
		if (section === "Where <competitor> is stronger") {
			if (
				!headings.some(
					(heading) =>
						/^where .+ (is|are) stronger/.test(heading) &&
						!heading.startsWith("where hobo"),
				)
			)
				problems.push({
					file: competitor.file,
					line: 1,
					message: `missing required section heading for "${section}"`,
				});
			continue;
		}
		const needle = section.toLowerCase();
		// SAFETY: assertion to `split(" is stronger")[0] as string; if ` is required at this boundary.
		const key = needle.split(" is stronger")[0] as string;
		if (!headings.some((heading) => heading.includes(key)))
			problems.push({
				file: competitor.file,
				line: 1,
				message: `missing required section heading for "${section}"`,
			});
	}
}

function checkLinks(
	root: string,
	file: string,
	text: string,
	problems: Problem[],
) {
	const dir = path.dirname(path.join(root, file));
	for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		// SAFETY: assertion to `] as string; if ` is required at this boundary.
		const target = match[1] as string;
		if (/^(https?:|mailto:|#)/.test(target)) continue;
		const [rel] = target.split("#");
		if (!rel) continue;
		const resolved = path.resolve(dir, rel);
		try {
			statSync(resolved);
		} catch {
			problems.push({
				file,
				line: lineOf(text, match[0]),
				message: `broken relative link "${target}"`,
			});
		}
	}
}

/**
 * The committed matrix is a pure function of the front matter. It used to print
 * each capture's age in days, and mark one stale past 180, so the file went out
 * of date the day after it was generated and `lint:docs` failed until someone
 * regenerated it. The ledger now lists the researched date and the contract
 * state, oldest first; the age against today's date is `staleCaptures`'s job,
 * run by the check itself.
 */
export function renderMatrix(competitors: Competitor[]) {
	const rows = [...competitors].sort((a, b) => a.slug.localeCompare(b.slug));
	const lines: string[] = [];
	lines.push("");
	lines.push(
		"| Competitor | Canonical doc | Aliases | Primary category | All categories | Directness | Contested HoBo surfaces | Posture | HoBo evidence | Product status | Researched | Contract |",
	);
	lines.push(
		"| ---------- | ------------- | ------- | ---------------- | -------------- | ---------- | ----------------------- | ------- | ------------- | -------------- | ---------- | -------- |",
	);
	for (const row of rows)
		lines.push(
			`| **${row.name}** | [\`${row.slug}.md\`](${row.slug}.md) | ${row.aliases.length ? row.aliases.join(", ") : "—"} | \`${row.primary_category}\` | ${row.categories.map((c) => `\`${c}\``).join(" · ")} | ${row.directness} | ${row.hobo_surface.join(", ")} | ${row.posture.join(", ")} | ${row.evidence} | ${row.status} | ${row.research_date} | ${row.contract ?? "pre-v1"} |`,
		);
	lines.push("");
	lines.push("### Freshness ledger");
	lines.push("");
	lines.push(
		`Captures are considered stale ${STALE_AFTER_DAYS} days after their researched date. Staleness never fails the build — it schedules refresh work: \`pnpm run docs:competitors\` lists the stale captures on the day it runs.`,
	);
	lines.push("");
	lines.push("| Competitor | Researched | State |");
	lines.push("| ---------- | ---------- | ----- |");
	for (const row of [...rows].sort(
		(a, b) =>
			a.research_date.localeCompare(b.research_date) ||
			a.slug.localeCompare(b.slug),
	))
		lines.push(
			`| [${row.name}](${row.slug}.md) | ${row.research_date} | ${row.contract === "v1" ? "contract v1" : "pre-v1 — rewrite to contract"} |`,
		);
	lines.push("");
	lines.push(
		`_${rows.length} canonical captures across ${new Set(rows.flatMap((r) => r.categories)).size} categories; ${rows.filter((r) => r.contract === "v1").length} at contract v1._`,
	);
	lines.push("");
	return lines.join("\n");
}

export type StaleCapture = {
	slug: string;
	name: string;
	research_date: string;
	/** Whole days between the researched date and the clock. */
	age: number;
};

/**
 * The captures researched more than `STALE_AFTER_DAYS` before `now`, oldest
 * first. The clock is a parameter so the policy can be tested; the check passes
 * the wall clock. Nothing derived from it is written to a committed file.
 */
export function staleCaptures(
	competitors: readonly Competitor[],
	now: number,
): StaleCapture[] {
	return competitors
		.map((row) => ({
			slug: row.slug,
			name: row.name,
			research_date: row.research_date,
			age: Math.floor(
				(now - Date.parse(`${row.research_date}T00:00:00Z`)) / 86_400_000,
			),
		}))
		.filter((row) => row.age > STALE_AFTER_DAYS)
		.sort((a, b) => b.age - a.age || a.slug.localeCompare(b.slug));
}

/** Category slug -> display title, mirroring the Linear project milestones. */
export const CATEGORY_TITLES = {
	"platform-orchestrators": "Comprehensive Platform Orchestrators",
	"portable-application-models": "Portable Application Models & Control Planes",
	"cloud-application-platforms": "Cloud Application Platforms",
	"developer-portals-idps": "Developer Portals & IDPs",
	"infrastructure-from-code": "Infrastructure-from-Code & Authoring",
	"runtime-substrates": "Runtime & Distributed Application Substrates",
	"hybrid-multicloud-enterprise":
		"Hybrid & Multicloud Enterprise Orchestration",
	"self-hosted-paas": "Self-Hosted PaaS & Server Deployment",
	"agentic-infrastructure": "Agentic Infrastructure & Operations",
	"backend-data-platforms": "Backend & Data Application Platforms",
	"delivery-release-gitops": "Delivery, Release & GitOps",
	"finops-governance-placement": "FinOps, Governance & Placement",
	"identity-networking-delivery": "Identity, Networking & Application Delivery",
} as const;

function byName(a: Competitor, b: Competitor) {
	return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

export function renderIndex(competitors: Competitor[]) {
	const lines: string[] = [""];
	lines.push(`## Categories (${CATEGORIES.length})`);
	lines.push("");
	lines.push("| Category | Competitors |");
	lines.push("| -------- | ----------- |");
	for (const category of CATEGORIES) {
		const members = competitors
			.filter((entry) => entry.categories.includes(category))
			.sort(byName);
		lines.push(
			`| [${CATEGORY_TITLES[category]}](categories/${category}.md) | ${members
				.map((entry) => `[${entry.name}](${entry.slug}.md)`)
				.join(" · ")} |`,
		);
	}
	lines.push("");
	lines.push(
		"Categories are many-to-many: several products appear in more than one row above, with a single canonical capture behind each link.",
	);
	lines.push("");
	lines.push(`## Canonical captures (${competitors.length})`);
	lines.push("");
	lines.push(
		"| Competitor | Capture | Primary category | Directness | Role relative to HoBo |",
	);
	lines.push(
		"| ---------- | ------- | ---------------- | ---------- | --------------------- |",
	);
	for (const entry of [...competitors].sort(byName))
		lines.push(
			`| **${entry.name}** | [\`${entry.slug}.md\`](${entry.slug}.md) | [\`${entry.primary_category}\`](categories/${entry.primary_category}.md) | ${entry.directness} | ${entry.role} |`,
		);
	lines.push("");
	lines.push("## Alias index");
	lines.push("");
	lines.push(
		"Renamed, acquired, and commonly-abbreviated products resolve to one canonical capture. There are no stub files for old names — look them up here.",
	);
	lines.push("");
	lines.push("| Alias / former name | Canonical capture |");
	lines.push("| ------------------- | ----------------- |");
	const aliases = competitors
		.flatMap((entry) => entry.aliases.map((alias) => ({ alias, entry })))
		.sort((a, b) => a.alias.toLowerCase().localeCompare(b.alias.toLowerCase()));
	for (const { alias, entry } of aliases)
		lines.push(`| \`${alias}\` | [${entry.name}](${entry.slug}.md) |`);
	lines.push("");
	return lines.join("\n");
}

export function renderCategoryIndex(competitors: Competitor[]) {
	const lines: string[] = [
		"",
		"| Category | Competitors |",
		"| -------- | ----------- |",
	];
	for (const category of CATEGORIES) {
		const count = competitors.filter((entry) =>
			entry.categories.includes(category),
		).length;
		lines.push(`| [${CATEGORY_TITLES[category]}](${category}.md) | ${count} |`);
	}
	lines.push("");
	return lines.join("\n");
}

export async function checkCompetitorDocs(options: {
	root: string;
	fix?: boolean;
	/** Injectable clock for the staleness report; defaults to the wall clock. */
	now?: number;
}): Promise<{
	problems: Problem[];
	competitors: Competitor[];
	/** Captures past the staleness line on `now`. A report, never a problem. */
	stale: StaleCapture[];
}> {
	const { root, fix = false } = options;
	const dir = path.join(root, "docs/competitors");
	const problems: Problem[] = [];
	const competitors: Competitor[] = [];

	for (const entry of listFiles(dir)) {
		const rel = `docs/competitors/${entry}`;
		const text = readFileSync(path.join(dir, entry), "utf8");
		checkLinks(root, rel, text, problems);
		if (NON_CAPTURE.has(entry)) continue;
		const parsed = frontMatter(text);
		if (!parsed) {
			problems.push({
				file: rel,
				line: 1,
				message: "missing YAML front matter",
			});
			continue;
		}
		if (Object.keys(parsed.raw).length === 0) {
			problems.push({
				file: rel,
				line: 1,
				message:
					"missing competitor: metadata block (see docs/competitors/metadata-contract.md)",
			});
			continue;
		}
		const competitor = parseCompetitor(rel, parsed.raw, problems, text);
		if (!competitor) continue;
		// Legacy captures predate the twelve-section contract. They are tracked as
		// pre-v1 in the ledger and rewritten by their own research issue rather than
		// being flattened into a generated summary to satisfy a heading check.
		if (competitor.contract === "v1")
			checkSections(competitor, parsed.body, problems);
		competitors.push(competitor);
	}

	// Slugs and aliases share one namespace so an old name can never resolve two ways.
	const seen = new Map<string, string>();
	for (const competitor of competitors)
		for (const key of [competitor.slug, ...competitor.aliases]) {
			const owner = seen.get(key.toLowerCase());
			if (owner)
				problems.push({
					file: competitor.file,
					line: 1,
					message: `"${key}" is already claimed by ${owner}`,
				});
			else seen.set(key.toLowerCase(), competitor.file);
		}

	// Category pages: every member linked, no non-member linked.
	const categoryDir = path.join(dir, "categories");
	for (const category of CATEGORIES) {
		const members = competitors.filter((competitor) =>
			competitor.categories.includes(category),
		);
		const rel = `docs/competitors/categories/${category}.md`;
		let text: string;
		try {
			text = readFileSync(path.join(categoryDir, `${category}.md`), "utf8");
		} catch {
			problems.push({
				file: rel,
				line: 1,
				message: `missing category index (the vocabulary is closed: every category has a page)`,
			});
			continue;
		}
		checkLinks(root, rel, text, problems);
		const linked = new Set(
			[...text.matchAll(/\]\(\.\.\/([a-z0-9-]+)\.md(?:#[^)]*)?\)/g)]
				.flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
				// Navigation links back to the corpus index/matrix/etc. are not rows.
				.filter((slug) => !NON_CAPTURE.has(`${slug}.md`)),
		);
		for (const member of members)
			if (!linked.has(member.slug))
				problems.push({
					file: rel,
					line: 1,
					message: `missing row linking ../${member.slug}.md (declares category "${category}")`,
				});
		for (const slug of linked) {
			const competitor = competitors.find((entry) => entry.slug === slug);
			if (!competitor)
				problems.push({
					file: rel,
					line: 1,
					message: `links ../${slug}.md, which is not a canonical competitor capture`,
				});
			else if (!competitor.categories.includes(category))
				problems.push({
					file: rel,
					line: 1,
					message: `links ../${slug}.md, which does not declare category "${category}"`,
				});
		}
	}

	for (const entry of listFiles(categoryDir)) {
		const slug = entry.replace(/\.md$/, "");
		// SAFETY: assertion to `nly string[]).includes(slug)) ` is required at this boundary.
		if (slug !== "index" && !(CATEGORIES as readonly string[]).includes(slug))
			problems.push({
				file: `docs/competitors/categories/${entry}`,
				line: 1,
				message: `"${slug}" is not a category in the closed vocabulary`,
			});
		if (slug === "index")
			checkLinks(
				root,
				`docs/competitors/categories/${entry}`,
				readFileSync(path.join(categoryDir, entry), "utf8"),
				problems,
			);
	}

	// Derived views must match the front-matter facts.
	const syncGenerated = (
		file: string,
		name: string,
		render: () => string,
		whenMissing: string,
	) => {
		const absolute = path.join(root, file);
		let text: string;
		try {
			text = readFileSync(absolute, "utf8");
		} catch {
			problems.push({ file, line: 1, message: whenMissing });
			return;
		}
		const begin = marker(name, "BEGIN");
		const end = marker(name, "END");
		const start = text.indexOf(begin);
		const stop = text.indexOf(end);
		if (start === -1 || stop === -1) {
			problems.push({
				file,
				line: 1,
				message: `missing generated markers (${begin} … ${end})`,
			});
			return;
		}
		const expected = `${begin}\n${render()}\n${end}`;
		const actual = text.slice(start, stop + end.length);
		if (actual === expected) return;
		if (fix) {
			writeFileSync(
				absolute,
				text.slice(0, start) + expected + text.slice(stop + end.length),
			);
			return;
		}
		problems.push({
			file,
			line: text.slice(0, start).split(/\r?\n/).length,
			message: `generated ${name} is out of date; run \`pnpm run docs:competitors:fix\``,
		});
	};

	syncGenerated(
		"docs/competitors/matrix.md",
		"competitor-matrix",
		() => renderMatrix(competitors),
		"missing generated cross-category matrix",
	);
	syncGenerated(
		"docs/competitors/index.md",
		"competitor-index",
		() => renderIndex(competitors),
		"missing corpus index",
	);
	syncGenerated(
		"docs/competitors/categories/index.md",
		"category-index",
		() => renderCategoryIndex(competitors),
		"missing category index",
	);

	return {
		problems,
		competitors,
		stale: staleCaptures(competitors, options.now ?? Date.now()),
	};
}

/**
 * The CLI body, as a function rather than a top-level `if`.
 *
 * Extracted so it can be tested: as an inline block it was unreachable from any
 * test, which left the exit code, the problem formatting and the summary line —
 * the parts CI and every human actually read — as the single largest untested
 * region of this file. Returns the exit code instead of calling `process.exit`
 * so a test can assert it without tearing down the runner.
 */
export async function main(options: {
	root: string;
	argv: readonly string[];
	now?: number;
	log?: (message: string) => void;
	error?: (message: string) => void;
}): Promise<number> {
	const log = options.log ?? console.log;
	const error = options.error ?? console.error;
	const checkInput: Parameters<typeof checkCompetitorDocs>[0] = {
		root: options.root,
		fix: options.argv.includes("--fix"),
	};
	if (options.now !== undefined) checkInput.now = options.now;
	const { problems, competitors, stale } =
		await checkCompetitorDocs(checkInput);
	for (const problem of problems)
		error(
			`${problem.file}:${problem.line} competitor-docs - ${problem.message}`,
		);
	log(
		`competitor-docs: ${competitors.length} canonical captures checked, ${problems.length} problem(s).`,
	);
	if (stale.length > 0) {
		log(
			`competitor-docs: ${stale.length} capture(s) older than ${STALE_AFTER_DAYS} days; refresh work is due (this does not fail the check):`,
		);
		for (const row of stale)
			log(`  - ${row.slug} (researched ${row.research_date}, ${row.age} days)`);
	}
	return problems.length > 0 ? 1 : 0;
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	process.exit(
		await main({
			root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
			argv: process.argv,
		}),
	);
}
