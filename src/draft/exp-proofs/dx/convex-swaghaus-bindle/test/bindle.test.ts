import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bindle } from "@hobo/bindles";
import { convexApp, isConvexWebAppAnnotation } from "@hobo/convex";

import {
	authorSwaghausBindle,
	BindleAuthoringParseError,
	draftSwaghausManifest,
	parseEnvRouting,
	parseSwaghausBindle,
} from "../src/index.ts";
import { type JsonValue } from "../src/json.js";


const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");
const APP_ROOT = "examples/convex-swaghaus";

describe("convex-swaghaus-bindle dx", () => {
	it("attaches convex webapp annotation", () => {
		const def = bindle((b) => ({
			web: b.web(convexApp("examples/convex-swaghaus")),
		}));
		expect(def.resources.web?.annotations.some(isConvexWebAppAnnotation)).toBe(
			true,
		);
	});
});

describe("manifest parse boundary", () => {
	it("parses the serialized manifest into a refined plan", () => {
		const { plan } = authorSwaghausBindle({ root: APP_ROOT, repoRoot });
		expect(plan.framework).toBe("convex");
		expect(plan.webRoot).toBe(APP_ROOT);
		expect(plan.web.kind).toBe("web");
		expect([...plan.resources].map((resource) => resource.kind).sort()).toEqual([
			"data",
			"external",
			"web",
		]);
	});

	it("routes every ship-required env name exactly once", () => {
		const { plan } = authorSwaghausBindle({ root: APP_ROOT });
		expect(
			plan.envDeps.map((dep) => `${dep.name}=${dep.routing}`),
		).toEqual([
			"CONVEX_DEPLOY_KEY=env",
			"VITE_CONVEX_URL=data",
			"VITE_WORKOS_CLIENT_ID=external",
			"VITE_WORKOS_REDIRECT_URI=external",
			"WORKOS_CLIENT_ID=external",
		]);
		expect(new Set(plan.envDeps.map((dep) => dep.name)).size).toBe(
			plan.envDeps.length,
		);
	});

	it("refuses an env name with no declared Bindle routing", () => {
		// SAFETY: `expect(() => parseEnvRouting("STRIPE_SECRET" as never)).toThrow(` is required at this I/O or test boundary.
		expect(() => parseEnvRouting("STRIPE_SECRET" as never)).toThrow(
			/no Bindle routing is declared/u,
		);
	});

	it("refuses a provider pin on the Bindle", () => {
		const manifest = draftSwaghausManifest({ root: APP_ROOT });
		// SAFETY: `const web = manifest.resources.web as { annotations: JsonValue[] };` is required at this I/O or test boundary.
		const web = manifest.resources.web as { annotations: JsonValue[] };
		web.annotations.push({
			provider: "convex",
			option: "deployment",
			config: { region: "us-east" },
		});
		expect(() => parseSwaghausBindle(manifest)).toThrow(
			/provider pin "convex" is not allowed on a Bindle/u,
		);
	});

	it("refuses plaintext secret material in annotation config", () => {
		const manifest = draftSwaghausManifest({ root: APP_ROOT });
		// SAFETY: `const web = manifest.resources.web as { annotations: JsonValue[] };` is required at this I/O or test boundary.
		const web = manifest.resources.web as { annotations: JsonValue[] };
		web.annotations.push({
			provider: "hobo",
			option: "webapp",
			config: { deployToken: "prod:swaghaus|deadbeef" },
		});
		expect(() => parseSwaghausBindle(manifest)).toThrow(
			/secret material never rides Bindle config/u,
		);
	});

	it("refuses a web Kit without the WorkOS external dependency", () => {
		const manifest = draftSwaghausManifest({ root: APP_ROOT });
		const trimmed = {
			...manifest,
			edges: manifest.edges.filter(
				// SAFETY: `(edge) => (edge as { to: string }).to !== "auth",` is required at this I/O or test boundary.
				(edge) => (edge as { to: string }).to !== "auth",
			),
		};
		expect(() => parseSwaghausBindle(trimmed)).toThrow(
			/needs a "external" dependency/u,
		);
	});

	it("refuses a web root that escapes the repo", () => {
		expect(() =>
			draftSwaghausManifest({ root: "examples/../../etc" }),
		).not.toThrow();
		const manifest = draftSwaghausManifest({ root: "examples/../../etc" });
		expect(() => parseSwaghausBindle(manifest)).toThrow(
			BindleAuthoringParseError,
		);
	});

	it("keeps the containment guard when a repo root is known", () => {
		const manifest = draftSwaghausManifest({ root: "examples" });
		expect(() => parseSwaghausBindle(manifest, { repoRoot })).not.toThrow();
	});
});

describe("documented event architecture stays truthful", () => {
	it("every control-plane fact the README names exists in @hobo/cloud", () => {
		const readme = readFileSync(
			path.join(import.meta.dirname, "..", "README.md"),
			"utf8",
		);
		const catalog = readFileSync(
			path.join(repoRoot, "packages/cloud/src/events.ts"),
			"utf8",
		);
		const named = [
			...new Set(
				[...readme.matchAll(/`([a-z]+\.[A-Z][A-Za-z]+)`/gu)].map(
					(match) => match[1],
				),
			),
		];
		expect(named.length).toBeGreaterThan(0);
		for (const fact of named) {
			expect(catalog, `${fact} is not a real @hobo/cloud fact`).toContain(
				`"${fact}"`,
			);
		}
	});
});
