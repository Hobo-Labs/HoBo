import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindle } from "@hobo/bindles";
import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	convexApp,
	convexRootFromAnnotations,
	discoverConvexEnv,
	isConvexWebAppAnnotation,
} from "../src/index.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

describe("@hobo/convex", () => {
	it("convexApp(root) is a thin marker; bindle attaches webapp annotation", () => {
		const definition = bindle((b) => {
			const backend = b.data();
			const auth = b.external({
				endpoints: { workos: "https://api.workos.com" },
			});
			const web = b
				.web(convexApp("examples/convex-swaghaus"))
				.dependsOn(backend, auth);
			return { backend, auth, web };
		});
		const root = convexRootFromAnnotations(
			must(definition.resources.web, "definition.resources.web").annotations,
		);
		expect(root).toBe("examples/convex-swaghaus");
		expect(
			definition.resources.web?.annotations.some(isConvexWebAppAnnotation),
		).toBe(true);
		expect(JSON.stringify(definition)).not.toMatch(/hobo\/convex-/u);
	});

	it("discoverConvexEnv finds swaghaus convex/ + WorkOS auth config", async () => {
		const discovered = await discoverConvexEnv(
			REPO_ROOT,
			"examples/convex-swaghaus",
		);
		expect(discovered.hasConvexDir).toBe(true);
		expect(discovered.hasAuthConfig).toBe(true);
		expect(discovered.generalEnv).toContain("CONVEX_DEPLOY_KEY");
		expect(discovered.generalEnv).toContain("VITE_WORKOS_CLIENT_ID");
		expect(discovered.suggestedDeps.some((d) => d.kind === "external")).toBe(
			true,
		);
		expect(discovered.suggestedDeps.some((d) => d.kind === "data")).toBe(true);
	});
});
