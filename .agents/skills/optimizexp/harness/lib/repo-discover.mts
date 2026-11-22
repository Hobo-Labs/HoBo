/**
 * Traverse a product repo for signals that drive OptimizeXP init:
 * product-aligned UX / DX / AX personas and journey seeds for features.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mts";
import {
	listProjects,
	resolveProjects,
	type ProjectRef,
	type ProjectSelection,
} from "./projects.mts";

export type Experience = "ux" | "dx" | "ax";

export type PersonaSeedPlan = {
	id: string;
	experiences: Experience[];
	interfaces: string[];
	priority: number;
	seed: string;
	source: string[];
	/** Project ids this persona primarily serves (`all` = repo-wide) */
	projects: string[];
};

export type FeatureSeedPlan = {
	id: string;
	title: string;
	seed: string;
	experiences: Experience[];
	driver: "cli" | "web" | "tui" | "native" | "mixed";
	surfaces: string[];
	source: string[];
	/** Persona experience tags that should review this feature by default */
	personaExperiences: Experience[];
	/** Project ids this journey belongs to */
	projects: string[];
};

export type ProductDiscovery = {
	scannedAt: string;
	root: string;
	productName: string;
	productSummary: string;
	/** Discovered multi-project registry ids in this scan */
	projectIds: string[];
	/** Active selection for this discovery (`all` or concrete ids) */
	selectedProjects: string[];
	signals: {
		hasSite: boolean;
		hasVisualTokens: boolean;
		hasCli: boolean;
		hasMcp: boolean;
		hasAgentsMd: boolean;
		hasPackageScripts: boolean;
		hasDraftExpProofs: boolean;
		scriptNames: string[];
		sitePages: string[];
		packages: string[];
	};
	personaPlans: PersonaSeedPlan[];
	featurePlans: FeatureSeedPlan[];
	notes: string[];
};

function readText(file: string, max = 12000): string {
	if (!existsSync(file)) return "";
	try {
		return readFileSync(file, "utf8").slice(0, max);
	} catch {
		return "";
	}
}

function listDirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith("."))
		.map((d) => d.name);
}

function listFiles(dir: string, ext?: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => !ext || f.endsWith(ext))
		.map((f) => path.join(dir, f));
}

function packageScripts(root: string): Record<string, string> {
	const p = path.join(root, "package.json");
	if (!existsSync(p)) return {};
	try {
		const j = JSON.parse(readFileSync(p, "utf8")) as {
			name?: string;
			scripts?: Record<string, string>;
		};
		return j.scripts ?? {};
	} catch {
		return {};
	}
}

function firstHeadingParagraph(md: string): { title: string; summary: string } {
	const lines = md.split(/\r?\n/);
	let title = "";
	const paras: string[] = [];
	for (const line of lines) {
		if (!title && /^#\s+/.test(line)) {
			title = line.replace(/^#\s+/, "").trim();
			continue;
		}
		if (title && line.trim() && !line.startsWith("#") && !line.startsWith("|") && !line.startsWith(">") && !line.startsWith("```")) {
			paras.push(line.trim());
			if (paras.join(" ").length > 280) break;
		}
	}
	return {
		title: title || "product",
		summary: paras.join(" ").slice(0, 400),
	};
}

function pickScripts(
	scripts: Record<string, string>,
	prefer: string[],
): string[] {
	const names = Object.keys(scripts);
	const out: string[] = [];
	for (const p of prefer) {
		if (names.includes(p)) out.push(p);
	}
	// also fuzzy
	for (const n of names) {
		if (out.includes(n)) continue;
		if (/doctor|check|lint|test|dev|build|design:lint|agent:check/.test(n)) {
			out.push(n);
		}
		if (out.length >= 12) break;
	}
	return out;
}

/**
 * Discover product surfaces and propose persona + feature seed plans.
 * @param projectSelection optional multi-project filter (default: all projects)
 */
export function discoverProduct(
	root = repoRoot(),
	projectSelection?: ProjectSelection,
): ProductDiscovery {
	const notes: string[] = [];
	const selection =
		projectSelection ?? resolveProjects(undefined, root);
	const selectedIds = new Set(
		selection.allProjects
			? listProjects(root).map((p) => p.id)
			: selection.projects.map((p) => p.id),
	);
	const includes = (...ids: string[]) =>
		selection.allProjects || ids.some((id) => selectedIds.has(id));

	const readme = readText(path.join(root, "README.md"));
	const { title, summary } = firstHeadingParagraph(readme);
	const pkg = existsSync(path.join(root, "package.json"))
		? (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
				name?: string;
				description?: string;
			})
		: {};
	const productName = title || pkg.name || path.basename(root);
	const productSummary =
		summary || pkg.description || "Repository product under OptimizeXP review.";

	const scripts = packageScripts(root);
	const scriptNames = Object.keys(scripts);
	const packagesDir = path.join(root, "packages");
	const packages = listDirs(packagesDir);
	const hasSite =
		includes("site") &&
		(existsSync(path.join(root, "site")) ||
			existsSync(path.join(root, "apps/web")) ||
			existsSync(path.join(root, "web")));
	const visualTokenCandidates = [
		path.join(root, "site/src/styles/global.css"),
		path.join(root, "site/src/styles/tokens.css"),
		path.join(root, "src/styles/tokens.css"),
	];
	const visualTokens = visualTokenCandidates.find((p) => existsSync(p));
	const hasVisualTokens = Boolean(visualTokens) && (includes("site") || includes("root"));
	const hasCli =
		includes("cli", "hobo", "root") &&
		(packages.includes("cli") ||
			packages.includes("hobo") ||
			existsSync(path.join(root, "packages/cli")) ||
			/\bcli\b/i.test(readme));
	const hasMcp =
		includes("mcp", "root") &&
		(packages.includes("mcp") ||
			existsSync(path.join(root, ".mcp.json")) ||
			existsSync(path.join(root, "packages/mcp")));
	const hasAgentsMd =
		includes("root") &&
		(existsSync(path.join(root, "AGENTS.md")) ||
			existsSync(path.join(root, "CLAUDE.md")));
	const hasDraftExpProofs =
		includes("root") && existsSync(path.join(root, "src/draft/exp-proofs"));

	const siteRoot =
		hasSite && existsSync(path.join(root, "site"))
			? path.join(root, "site")
			: hasSite && existsSync(path.join(root, "apps/web"))
				? path.join(root, "apps/web")
				: "";
	const sitePages: string[] = [];
	if (siteRoot) {
		const pagesDir = path.join(siteRoot, "src/pages");
		if (existsSync(pagesDir)) {
			for (const name of listDirs(pagesDir)) sitePages.push(name);
			for (const f of readdirSync(pagesDir)) {
				if (/\.(astro|md|mdx|tsx|html)$/.test(f)) sitePages.push(f);
			}
		}
	}

	const personaPlans: PersonaSeedPlan[] = [];
	const featurePlans: FeatureSeedPlan[] = [];
	const projectList = listProjects(root);

	// --- Personas aligned to product ---
	if (hasSite || hasVisualTokens) {
		personaPlans.push({
			id: "product-end-user",
			experiences: ["ux"],
			interfaces: ["web", "docs"],
			priority: 20,
			seed: `End user evaluating or using ${productName} through the public website and docs. Scans quickly; abandons confusing paths. Product: ${productSummary.slice(0, 160)}`,
			source: ["README.md", siteRoot ? "site/" : "", visualTokens || ""].filter(Boolean),
			projects: hasSite ? ["site"] : ["root"],
		});
		personaPlans.push({
			id: "product-designer",
			experiences: ["ux"],
			interfaces: ["web", "docs"],
			priority: 25,
			seed: `Product/brand designer for ${productName}'s public UI. Needs consistent implemented tokens, inclusive visuals, and verifiable contrast.`,
			source: [visualTokens || "site/", "README.md"].filter(Boolean),
			projects: hasSite ? ["site"] : ["root"],
		});
	} else if (includes("site")) {
		notes.push("No selected site or UI token source was found; skipped UX personas.");
	} else {
		notes.push("No selected site or UI token source was found; skipped default UX personas.");
	}

	if ((hasCli || scriptNames.length > 0 || packages.length > 0) && includes("root", "cli", "hobo")) {
		const dxProjects = ["root"];
		if (selectedIds.has("cli") || selection.allProjects) dxProjects.push("cli");
		if (selectedIds.has("hobo") || selection.allProjects) dxProjects.push("hobo");
		personaPlans.push({
			id: "product-app-developer",
			experiences: ["dx", "ax"],
			interfaces: ["cli", "docs", "config", "mcp"],
			priority: 10,
			seed: `Application developer shipping on ${productName}. Uses TypeScript, package scripts, and ${hasCli ? "the product CLI" : "repo scripts"}. Wants narrow green checks and clear failures. Product: ${productSummary.slice(0, 120)}`,
			source: ["package.json", hasCli ? "packages/cli" : "packages/", "README.md"],
			projects: [...new Set(dxProjects)],
		});
		personaPlans.push({
			id: "product-platform-engineer",
			experiences: ["dx", "ax"],
			interfaces: ["cli", "config", "hooks", "docs"],
			priority: 15,
			seed: `Platform engineer owning monorepo gates, CI, hooks, and package boundaries for ${productName}. Cares about impact-scoped checks and multi-agent config consistency.`,
			source: ["package.json", ".githooks", "AGENTS.md"].filter((p) =>
				existsSync(path.join(root, p.replace(/\/$/, ""))) || p === "package.json",
			),
			projects: ["root"],
		});
	}

	if ((hasAgentsMd || hasMcp) && includes("root", "mcp")) {
		personaPlans.push({
			id: "product-agent-operator",
			experiences: ["ax", "dx"],
			interfaces: ["mcp", "config", "docs", "cli"],
			priority: 12,
			seed: `Operator configuring coding agents for ${productName}: MCP servers, skills, hooks, plugins, and secretless-first keys. Accountable for egress and setup friction.`,
			source: ["AGENTS.md", "docs/agent-tooling.md", ".mcp.json"].filter((p) =>
				existsSync(path.join(root, p)),
			),
			projects: hasMcp ? ["root", "mcp"] : ["root"],
		});
		personaPlans.push({
			id: "product-coding-agent",
			experiences: ["ax", "dx"],
			interfaces: ["cli", "mcp", "docs", "config"],
			priority: 18,
			seed: `Automated coding agent working in the ${productName} repo under AGENTS.md and skills. Needs progressive disclosure, parseable gates, and write-ahead clarity.`,
			source: ["AGENTS.md", ".agents/skills", ".claude/skills"].filter((p) =>
				existsSync(path.join(root, p)),
			),
			projects: ["root"],
		});
	} else if (includes("mcp") || includes("root")) {
		notes.push("No AGENTS.md/MCP in selected projects — skipped default AX personas.");
	}

	// Roles from site if present
	const rolesDir = siteRoot
		? path.join(siteRoot, "src/pages/roles")
		: "";
	if (rolesDir && existsSync(rolesDir)) {
		for (const f of readdirSync(rolesDir).filter((x) => x.endsWith(".md"))) {
			const role = f.replace(/\.md$/, "");
			if (role === "index") continue;
			const id = `role-${role}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
			if (personaPlans.some((p) => p.id === id)) continue;
			personaPlans.push({
				id,
				experiences: role.includes("dev") ? ["dx"] : ["ux", "dx"],
				interfaces: ["docs", "web", "cli"],
				priority: 50,
				seed: `Persona aligned to documented product role "${role}" for ${productName}. See site roles docs.`,
				source: [`site/src/pages/roles/${f}`],
				projects: ["site"],
			});
		}
	}

	// --- Features / journeys ---
	if (hasSite) {
		featurePlans.push({
			id: "public-site-first-impression",
			title: "Public site first impression",
			seed: `A visitor lands on the ${productName} public site and can understand what the product is, navigate primary docs, and leave with a clear next step within two minutes.`,
			experiences: ["ux"],
			driver: "web",
			surfaces: siteRoot ? [`file:${path.relative(root, siteRoot)}`] : [],
			source: ["site/", "README.md"],
			personaExperiences: ["ux"],
			projects: ["site"],
		});
	}
	const designLint = scripts["design:lint"] ?? "";
	const hasTrustedVisualCheck =
		/(?:^|[\s"'])(?:\.\/)?scripts\/check-visual-tokens\.mts(?:$|[\s"'])/u.test(
			designLint,
		) && existsSync(path.join(root, "scripts/visual-token-contract.json"));
	if (hasVisualTokens && hasTrustedVisualCheck) {
		featurePlans.push({
			id: "design-system-contract",
			title: "Design system contract is agent-followable",
			seed: `A designer or agent edits implemented UI tokens; visual checks fail on contrast violations with file references.`,
			experiences: ["ux", "dx"],
			driver: "cli",
			surfaces: ["pnpm run design:lint"],
			source: [visualTokens || "site/src/styles/global.css"],
			personaExperiences: ["ux", "dx"],
			projects: hasSite ? ["site", "root"] : ["root"],
		});
	} else if (hasSite || hasVisualTokens) {
		const source = visualTokens
			? path.relative(root, visualTokens)
			: "site/src/styles/global.css";
		notes.push(
			`Unresolved visual check: ${source} has no executable design:lint contrast gate.`,
		);
		featurePlans.push({
			id: "design-system-contract-unresolved",
			title: "Unresolved: executable visual-token contrast gate",
			seed: `The discovered palette is not an executed check. Add an executable design:lint contrast gate before claiming visual validation.`,
			experiences: ["ux", "dx"],
			driver: "cli",
			surfaces: [],
			source: [source],
			personaExperiences: ["ux", "dx"],
			projects: hasSite ? ["site", "root"] : ["root"],
		});
	}

	const preferredScripts = pickScripts(scripts, [
		"doctor",
		"agent:check",
		"lint",
		"test:file",
		"test:smoke",
		"build",
		"dev",
	]);
	if (
		includes("root") &&
		(preferredScripts.includes("agent:check") || preferredScripts.includes("doctor"))
	) {
		const cmd = scripts["agent:check"]
			? "pnpm run agent:check -- --staged"
			: `pnpm run ${preferredScripts[0]}`;
		featurePlans.push({
			id: "narrow-local-validation",
			title: "Narrow local validation after a small change",
			seed: `After a one-package or staged edit in ${productName}, the developer runs a narrow validation command (\`${cmd}\`) and gets a clear gate list or fix-forward error without a full monorepo ritual.`,
			experiences: ["dx", "ax"],
			driver: "cli",
			surfaces: [cmd],
			source: ["package.json", "AGENTS.md"],
			personaExperiences: ["dx", "ax"],
			projects: ["root"],
		});
	} else if (includes("root") && preferredScripts.length > 0) {
		const cmd = `pnpm run ${preferredScripts[0]}`;
		featurePlans.push({
			id: "primary-dev-script",
			title: "Primary developer script is discoverable",
			seed: `A developer finds and runs \`${cmd}\` for ${productName} and understands success/failure without tribal knowledge.`,
			experiences: ["dx"],
			driver: "cli",
			surfaces: [cmd],
			source: ["package.json"],
			personaExperiences: ["dx"],
			projects: ["root"],
		});
	}

	if (hasCli) {
		featurePlans.push({
			id: "cli-help-and-doctor",
			title: "CLI help and doctor path",
			seed: `A developer or agent runs the ${productName} CLI help/doctor (or equivalent) and gets actionable status without live cloud credentials.`,
			experiences: ["dx", "ax"],
			driver: "cli",
			surfaces: scripts["doctor"]
				? ["pnpm run doctor"]
				: ["pnpm exec hobo --help", "pnpm run doctor"].filter(Boolean),
			source: ["packages/cli", "packages/hobo", "package.json"],
			personaExperiences: ["dx", "ax"],
			projects: ["cli", "hobo", "root"].filter(
				(id) => selection.allProjects || selectedIds.has(id) || id === "root",
			),
		});
	}

	if (hasMcp || hasAgentsMd) {
		featurePlans.push({
			id: "agent-tooling-setup",
			title: "Agent tooling progressive setup",
			seed: `An agent operator configures coding agents for ${productName} with a zero-key default path; MCP/skills docs match committed config; optional key tools fail closed with remediation.`,
			experiences: ["ax", "dx"],
			driver: "cli",
			surfaces: [
				existsSync(path.join(root, "scripts/setup-agent-tools.sh"))
					? "bash scripts/setup-agent-tools.sh --help"
					: "file:docs/agent-tooling.md",
			],
			source: ["docs/agent-tooling.md", "AGENTS.md", ".mcp.json"],
			personaExperiences: ["ax"],
			projects: hasMcp ? ["root", "mcp"] : ["root"],
		});
	}

	if (hasDraftExpProofs) {
		const expTypes = listDirs(path.join(root, "src/draft/exp-proofs")).filter(
			(d) => ["ux", "dx", "cx", "ax", "api"].includes(d),
		);
		if (expTypes.length) {
			notes.push(
				`Draft exp-proofs present (${expTypes.join(", ")}) — product journeys may later promote from proofs.`,
			);
			featurePlans.push({
				id: "draft-experience-proof-navigation",
				title: "Draft experience proofs are navigable",
				seed: `A platform engineer or agent locates experience proofs under src/draft/exp-proofs/ for ${productName} and understands classification (ux/dx/ax/…) without guessing.`,
				experiences: ["dx", "ax"],
				driver: "cli",
				surfaces: ["file:src/draft/exp-proofs/_classification.md"],
				source: ["src/draft/exp-proofs/"],
				personaExperiences: ["dx", "ax"],
				projects: ["root"],
			});
		}
	}

	// Example apps as light features when selected
	for (const pref of selection.projects.filter((p) => p.kind === "example")) {
		featurePlans.push({
			id: `example-${pref.id}`,
			title: `Example app ${pref.id} is approachable`,
			seed: `A developer opens example project ${pref.path} for ${productName}, finds how to run or inspect it, and understands its relation to the core product without live cloud.`,
			experiences: ["dx"],
			driver: "cli",
			surfaces: [`file:${pref.path}`],
			source: [pref.path],
			personaExperiences: ["dx"],
			projects: [pref.id],
		});
	}

	// Deduplicate by id
	const seenP = new Set<string>();
	const uniquePersonas = personaPlans.filter((p) => {
		if (seenP.has(p.id)) return false;
		seenP.add(p.id);
		return true;
	});
	const seenF = new Set<string>();
	const uniqueFeatures = featurePlans.filter((f) => {
		if (seenF.has(f.id)) return false;
		seenF.add(f.id);
		return true;
	});

	if (uniquePersonas.length === 0) {
		notes.push(
			"No personas inferred — adding generic developer + end-user fallbacks.",
		);
		uniquePersonas.push(
			{
				id: "product-app-developer",
				experiences: ["dx"],
				interfaces: ["cli", "docs"],
				priority: 10,
				seed: `Developer working in ${productName}: ${productSummary.slice(0, 200)}`,
				source: ["README.md"],
				projects: ["root"],
			},
			{
				id: "product-end-user",
				experiences: ["ux"],
				interfaces: ["docs"],
				priority: 20,
				seed: `End user of ${productName} reading product docs.`,
				source: ["README.md"],
				projects: ["root"],
			},
		);
	}

	if (!selection.allProjects && selection.unknown.length) {
		notes.push(`Unknown project id(s): ${selection.unknown.join(", ")}`);
	}
	notes.push(
		selection.allProjects
			? `Projects: all (${projectList.map((p) => p.id).join(", ")})`
			: `Projects: ${selection.projects.map((p) => p.id).join(", ")}`,
	);

	return {
		scannedAt: new Date().toISOString(),
		root,
		productName,
		productSummary,
		projectIds: projectList.map((p) => p.id),
		selectedProjects: selection.allProjects
			? ["all"]
			: selection.projects.map((p) => p.id),
		signals: {
			hasSite,
			hasVisualTokens,
			hasCli,
			hasMcp,
			hasAgentsMd,
			hasPackageScripts: scriptNames.length > 0,
			hasDraftExpProofs,
			scriptNames: pickScripts(scripts, scriptNames).slice(0, 30),
			sitePages: sitePages.slice(0, 40),
			packages: packages.slice(0, 80),
		},
		personaPlans: uniquePersonas,
		featurePlans: uniqueFeatures,
		notes,
	};
}

export function filterDiscovery(
	d: ProductDiscovery,
	experiences: Experience[],
): ProductDiscovery {
	const exp = new Set(experiences);
	return {
		...d,
		personaPlans: d.personaPlans.filter((p) =>
			p.experiences.some((e) => exp.has(e)),
		),
		featurePlans: d.featurePlans.filter((f) =>
			f.experiences.some((e) => exp.has(e)),
		),
	};
}
