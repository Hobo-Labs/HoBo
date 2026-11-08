/** Single source of truth for header and sidebar navigation. */

export type NavItem = { label: string; slug: string };
export type NavGroup = { label: string; slug: string; items: NavItem[] };

/**
 * Sections — the layer the header actually renders.
 *
 * Fourteen top-level groups did not fit: 129 characters of label needs roughly
 * 1300px in an 1160px container, so the nav was clipped at every width above
 * the 760px hamburger breakpoint. It was only ever usable collapsed.
 *
 * Five sections, named for what a visitor is *doing* rather than what the
 * codebase is organised as. The fourteen groups survive underneath — this
 * nests them, it does not renumber them, so every existing slug still
 * resolves and the sidebar can finally show one section instead of all 109
 * links on every page.
 */
export type NavSection = { label: string; slug: string; groups: string[] };

export const sections: NavSection[] = [
	{
		label: "Learn",
		slug: "/guide/",
		groups: ["Guide", "Primitives", "Architecture", "Roles"],
	},
	{
		label: "Examples",
		slug: "/examples/",
		groups: ["Examples", "Customizations", "CI/CD", "Testing"],
	},
	{
		label: "Operate",
		slug: "/operations/",
		groups: ["Operations", "Observability", "Security", "Troubleshooting"],
	},
	{ label: "Reference", slug: "/reference/", groups: ["Reference"] },
	{ label: "Agents", slug: "/agents/", groups: ["The Crew"] },
];

/** The groups belonging to a section, in declared order. */
export function groupsOf(section: NavSection, groups: NavGroup[]): NavGroup[] {
	return section.groups
		.map((label) => groups.find((g) => g.label === label))
		.filter((g): g is NavGroup => g !== undefined);
}

/**
 * Which section owns a path.
 *
 * Listing a page is not owning it. `/reference/session-replay/` is *listed*
 * under both Observability and Reference, so a plain `find` badged it with
 * whichever came first — "Observability".
 *
 * Longest-match does not fix that: the two groups list the page under the
 * identical slug string, so length can never break the tie. The discriminator
 * is which **namespace root** the path falls under. A section slug or a group
 * slug is a root; an item slug is only a listing. `/reference/session-replay/`
 * sits under the Reference group's `/reference/` and under no other root, so
 * Reference owns it however many groups link to it.
 *
 * Roots are checked longest-first so a nested root beats its parent. Only when
 * no root claims the path do we fall back to whoever lists it — that fallback
 * is what still resolves pages living outside every group's namespace.
 */
export function sectionFor(
	path: string,
	groups: NavGroup[],
): NavSection | undefined {
	let root: { section: NavSection; len: number } | undefined;
	let listed: { section: NavSection; len: number } | undefined;

	for (const section of sections) {
		const roots = [section.slug, ...groupsOf(section, groups).map((g) => g.slug)];
		for (const slug of roots) {
			if (path.startsWith(slug) && slug.length > (root?.len ?? 0)) {
				root = { section, len: slug.length };
			}
		}
		for (const group of groupsOf(section, groups)) {
			for (const item of group.items) {
				if (path.startsWith(item.slug) && item.slug.length > (listed?.len ?? 0)) {
					listed = { section, len: item.slug.length };
				}
			}
		}
	}

	return (root ?? listed)?.section;
}

export const nav: NavGroup[] = [
	{
		label: "Examples",
		slug: "/examples/",
		items: [{ label: "Try HoBo", slug: "/examples/" }],
	},
	{
		label: "Guide",
		slug: "/guide/",
		items: [
			{ label: "What is HoBo?", slug: "/guide/" },
			{ label: "Getting started", slug: "/guide/getting-started/" },
			{ label: "Core concepts", slug: "/guide/concepts/" },
			{ label: "The hobo CLI", slug: "/guide/cli/" },
			{ label: "The trail map", slug: "/guide/status/" },
			{ label: "Search", slug: "/search/" },
		],
	},
	{
		label: "Architecture",
		slug: "/architecture/",
		items: [
			{ label: "Architecture overview", slug: "/architecture/" },
			{ label: "Data plane", slug: "/architecture/data-plane/" },
			{ label: "Control plane", slug: "/architecture/control-plane/" },
			{ label: "WASM & WIT surface", slug: "/architecture/wasm/" },
			{ label: "Air-gapped & sovereign", slug: "/architecture/air-gapped/" },
		],
	},
	{
		label: "Security",
		slug: "/security/",
		items: [
			{ label: "Security overview", slug: "/security/" },
			{ label: "Identity & auth", slug: "/security/identity/" },
			{ label: "Multi-tenant & policy", slug: "/security/multi-tenant/" },
			{ label: "Connectivity & networking", slug: "/security/connectivity/" },
			{ label: "Agent credentials", slug: "/security/credentials/" },
		],
	},
	{
		label: "CI/CD",
		slug: "/cicd/",
		items: [
			{ label: "CI/CD overview", slug: "/cicd/" },
			{ label: "Continuous migration", slug: "/cicd/migration/" },
			{ label: "Progressive delivery", slug: "/cicd/progressive-delivery/" },
			{ label: "Generation pipeline", slug: "/cicd/generation/" },
		],
	},
	{
		label: "Primitives",
		slug: "/primitives/",
		items: [
			{ label: "Meet the primitives", slug: "/primitives/" },
			{ label: "Bindles", slug: "/primitives/bindles/" },
			{ label: "App Kits", slug: "/primitives/app-kits/" },
			{ label: "Camps", slug: "/primitives/camps/" },
			{ label: "Yards", slug: "/primitives/yards/" },
			{ label: "Junctions", slug: "/primitives/junctions/" },
			{ label: "Stations & Conductor", slug: "/primitives/stations/" },
			{ label: "Trails", slug: "/primitives/trails/" },
			{ label: "Resource catalog", slug: "/primitives/resources/" },
		],
	},
	{
		label: "Operations",
		slug: "/operations/",
		items: [
			{ label: "Built-in operators", slug: "/operations/" },
			{ label: "Shared model", slug: "/operations/shared-model/" },
			{ label: "SRE", slug: "/operations/sre/" },
			{ label: "Endpoint Monitor", slug: "/operations/endpoint-monitor/" },
			{ label: "GitOps", slug: "/operations/gitops/" },
			{ label: "Platform Engineer", slug: "/operations/platform-engineer/" },
			{ label: "SWE", slug: "/operations/swe/" },
			{ label: "UX Designer", slug: "/operations/ux-designer/" },
			{ label: "FinOps", slug: "/operations/finops/" },
			{ label: "Handoffs & A2H", slug: "/operations/handoffs/" },
			{ label: "Runbooks", slug: "/operations/runbooks/" },
			{ label: "Engines & ports", slug: "/operations/engines/" },
		],
	},
	{
		label: "The Crew",
		slug: "/crew/",
		items: [
			{ label: "Custom ACP agents", slug: "/crew/" },
			{ label: "HoBo for Agents", slug: "/agents/" },
			{ label: "The MCP surface", slug: "/agents/mcp/" },
		],
	},
	{
		label: "Observability",
		slug: "/observability/",
		items: [
			{ label: "Observability overview", slug: "/observability/" },
			{ label: "Agent audit & replay", slug: "/observability/agent-audit/" },
			{ label: "Session Replay", slug: "/reference/session-replay/" },
			{ label: "Metering", slug: "/reference/metering/" },
		],
	},
	{
		label: "Troubleshooting",
		slug: "/troubleshooting/",
		items: [
			{ label: "Troubleshooting overview", slug: "/troubleshooting/" },
			{ label: "Common failures", slug: "/troubleshooting/common-failures/" },
			{ label: "Local debugging", slug: "/troubleshooting/local/" },
			{ label: "Remote development", slug: "/troubleshooting/bridge/" },
			{ label: "Remote debugging", slug: "/troubleshooting/remote/" },
		],
	},
	{
		label: "Customizations",
		slug: "/customizations/",
		items: [
			{ label: "Customizations overview", slug: "/customizations/" },
			{ label: "Custom providers", slug: "/customizations/providers/" },
			{ label: "IaC engines", slug: "/customizations/iac/" },
			{ label: "Messaging integrations", slug: "/customizations/messaging/" },
			{ label: "Connectors", slug: "/customizations/connectors/" },
		],
	},
	{
		label: "Testing",
		slug: "/testing/",
		items: [
			{ label: "Testing overview", slug: "/testing/" },
			{ label: "Unit tests & boundaries", slug: "/testing/unit/" },
			{ label: "Aggregates & CQRS", slug: "/testing/aggregates/" },
			{ label: "Contracts & PACT", slug: "/testing/contracts/" },
			{ label: "Effect-aware isolation", slug: "/testing/effects/" },
			{ label: "Dual fixtures", slug: "/testing/dual-fixtures/" },
			{ label: "Durable EventStore", slug: "/testing/durability/" },
			{ label: "Migration fixtures", slug: "/testing/migration/" },
			{ label: "Queue, timer, outbox", slug: "/testing/queue-outbox/" },
			{ label: "Deployment rehearsal", slug: "/testing/deployment/" },
			{ label: "Bridge modes", slug: "/testing/bridge-modes/" },
			{ label: "Chaos & availability", slug: "/testing/chaos/" },
			{ label: "Property & model tests", slug: "/testing/property/" },
			{ label: "Behavior & Cucumber", slug: "/testing/behavior/" },
			{ label: "Benchmarks", slug: "/testing/benchmarks/" },
			{ label: "Conformance & golden", slug: "/testing/conformance/" },
			{ label: "What not to do", slug: "/testing/anti-patterns/" },
		],
	},
	{
		label: "Reference",
		slug: "/reference/",
		items: [
			{ label: "Reference overview", slug: "/reference/" },
			{ label: "Capability map", slug: "/reference/packages/" },
			{ label: "Component hosts", slug: "/reference/component-hosts/" },
			{ label: "EventStore & journal", slug: "/reference/eventstore/" },
			{ label: "Schema & migrations", slug: "/reference/schema/" },
			{ label: "Queue port", slug: "/reference/queue/" },
			{ label: "Messaging, Kafka & Dapr", slug: "/reference/messaging/" },
			{ label: "Streamer port", slug: "/reference/streamer/" },
			{ label: "ActorHost & fencing", slug: "/reference/actor-host/" },
			{ label: "Clock port", slug: "/reference/clock/" },
			{ label: "Runtime ports", slug: "/reference/runtime-ports/" },
			{ label: "Contracts & Gatekeeper", slug: "/reference/contracts/" },
			{ label: "Effects & resiliency", slug: "/reference/effects/" },
			{ label: "Policy plane", slug: "/reference/policy/" },
			{ label: "Matching & ResourceActors", slug: "/reference/matching/" },
			{ label: "Harness & progressive", slug: "/reference/harness/" },
			{ label: "Event families", slug: "/reference/events/" },
			{ label: "Errors & codes", slug: "/reference/errors/" },
			{ label: "CLI surface", slug: "/reference/cli/" },
			{ label: "WIT & storage", slug: "/reference/wit-storage/" },
			{ label: "Identity ports", slug: "/reference/identity/" },
			{ label: "Naming & endpoints", slug: "/reference/naming/" },
			{ label: "Connectivity", slug: "/reference/connectivity/" },
			{ label: "Config & secrets", slug: "/reference/config-secrets/" },
			{ label: "Metering", slug: "/reference/metering/" },
			{ label: "Session Replay", slug: "/reference/session-replay/" },
			{ label: "Glossary", slug: "/reference/glossary/" },
		],
	},
	{
		label: "Roles",
		slug: "/roles/",
		items: [
			{ label: "Who writes what", slug: "/roles/" },
			{ label: "HoBo for Developers", slug: "/roles/developers/" },
			{ label: "HoBo for Platform Engineers", slug: "/roles/platform-engineers/" },
			{ label: "HoBo for DevSecOps", slug: "/roles/devsecops/" },
			{ label: "HoBo for SREs", slug: "/roles/sre/" },
			{ label: "HoBo for FinOps", slug: "/roles/finops/" },
			{ label: "HoBo for Agents", slug: "/agents/" },
		],
	},
];
