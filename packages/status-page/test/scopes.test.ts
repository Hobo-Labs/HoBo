import { bindle, statusPage } from "@hobo/bindles";
import { BINDLE_PRIMITIVES } from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_PROJECT,
	deriveBindleStatusPlan,
	deriveProjectStatusPlans,
	primitiveComponents,
	primitivesStatusScope,
	stationCapabilityComponents,
	stationStatusScope,
} from "../src/index.js";

describe("bindle status plans (default-on, ADR-0145)", () => {
	it("derives a page for a bindle with no annotation at all", () => {
		const app = bindle("shop", (b) => ({
			web: b.web(),
			api: b.api(),
			cache: b.kv(),
		}));
		const plan = deriveBindleStatusPlan(app);
		expect(plan.reason).toBe("default-on");
		expect(plan.scope).toEqual({
			kind: "bindle",
			id: "shop",
			label: "shop status",
		});
		expect(plan.project).toBe(DEFAULT_PROJECT);
		// App kits become components; infra kits (kv) do not.
		expect(plan.components.map((c) => c.id).sort()).toEqual([
			"kit-api",
			"kit-web",
		]);
	});

	it("includes configured service dependencies as components", () => {
		const app = bindle("shop", (b) => ({
			web: b.web(),
			db: b.external({ endpoints: { http: "https://db.example.com" } }),
			worker: b.container({ image: "ghcr.io/acme/worker:1" }),
		}));
		const plan = deriveBindleStatusPlan(app);
		const byId = new Map(plan.components.map((c) => [c.id, c]));
		expect(byId.get("dep-db")?.kind).toBe("dependency");
		expect(byId.get("dep-worker")?.kind).toBe("dependency");
		expect(byId.get("dep-worker")?.label).toContain("ghcr.io/acme/worker:1");
	});

	it("honors per-resource opt-out without deleting the page", () => {
		const app = bindle("shop", (b) => ({
			web: b.web(),
			worker: b.job().with(statusPage({ enabled: false })),
		}));
		const plan = deriveBindleStatusPlan(app);
		expect(plan.components.map((c) => c.id)).toEqual(["kit-web"]);
		expect(plan.disabledComponents).toEqual([
			{ id: "kit-worker", reason: "opted-out" },
		]);
	});

	it("keeps the page even when every component opts out", () => {
		const app = bindle("shop", (b) => ({
			web: b.web().with(statusPage({ enabled: false })),
		}));
		const plan = deriveBindleStatusPlan(app);
		expect(plan.components).toHaveLength(0);
		expect(plan.scope.id).toBe("shop");
	});

	it("reads project and label from the annotation", () => {
		const app = bindle("shop", (b) => ({
			web: b
				.web()
				.with(statusPage({ project: "storefront", label: "Shop storefront" })),
		}));
		const plan = deriveBindleStatusPlan(app);
		expect(plan.reason).toBe("annotated");
		expect(plan.project).toBe("storefront");
		expect(plan.scope.label).toBe("Shop storefront");
	});

	it("replaces rather than stacks a re-applied statusPage annotation", () => {
		const app = bindle("shop", (b) => ({
			web: b
				.web()
				.with(statusPage({ project: "old" }))
				.with(statusPage({ project: "new" })),
		}));
		expect(deriveBindleStatusPlan(app).project).toBe("new");
	});
});

describe("project status plans", () => {
	it("groups bindles by project with one page per project", () => {
		const a = bindle("shop", (b) => ({
			web: b.web().with(statusPage({ project: "storefront" })),
		}));
		const c = bindle("blog", (b) => ({ web: b.web() }));
		const plans = deriveProjectStatusPlans([a, c]);
		expect(plans.map((p) => p.project)).toEqual(["default", "storefront"]);
		const storefront = plans.find((p) => p.project === "storefront");
		expect(storefront?.scope).toEqual({
			kind: "project",
			id: "storefront",
			label: "Project storefront",
		});
		expect(storefront?.bindles.map((b) => b.scope.id)).toEqual(["shop"]);
	});

	it("deduplicates shared dependencies across bindles", () => {
		const shared = { endpoints: { http: "https://db.example.com" } };
		const a = bindle("shop", (b) => ({
			web: b.web(),
			db: b.external(shared),
		}));
		const c = bindle("blog", (b) => ({
			web: b.web(),
			db: b.external(shared),
		}));
		const plans = deriveProjectStatusPlans([a, c]);
		const project = plans[0];
		const depComponents = project?.components.filter(
			(component) => component.kind === "dependency",
		);
		expect(depComponents).toHaveLength(1);
		expect(project?.components.map((c) => c.id)).toContain("bindle-shop");
		expect(project?.components.map((c) => c.id)).toContain("bindle-blog");
	});

	it("guarantees at least one page per bindle", () => {
		const definitions = [
			bindle("a", (b) => ({ web: b.web() })),
			bindle("b", (b) => ({ api: b.api() })),
		];
		const plans = deriveProjectStatusPlans(definitions);
		const bindlePages = plans.flatMap((p) => p.bindles);
		expect(bindlePages).toHaveLength(2);
	});
});

describe("station and primitives scopes", () => {
	it("builds station components from capabilities, deduplicated", () => {
		const specs = stationCapabilityComponents([
			{ kind: "sidecar", slug: "dashboard" },
			{ kind: "sidecar", slug: "dashboard" },
			{ kind: "runtime", slug: "node" },
		]);
		expect(specs.map((s) => s.id)).toEqual([
			"sidecar-dashboard",
			"runtime-node",
		]);
		expect(specs[0]?.kind).toBe("sidecar");
		expect(specs[1]?.kind).toBe("capability");
	});

	it("sanitizes station ids into scope ids", () => {
		const scope = stationStatusScope("Local Station #1");
		expect(scope.kind).toBe("station");
		expect(scope.id).toBe("local-station-1");
	});

	it("mirrors the closed primitive vocabulary without a fourth list", () => {
		const components = primitiveComponents();
		expect(components).toHaveLength(BINDLE_PRIMITIVES.length);
		expect(components.map((c) => c.label)).toEqual([...BINDLE_PRIMITIVES]);
		expect(primitivesStatusScope().kind).toBe("primitives");
	});
});
