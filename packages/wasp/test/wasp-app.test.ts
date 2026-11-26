import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindle } from "@hobo/bindles";
import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	discoverWaspEnv,
	isWaspWebAppAnnotation,
	waspApp,
	waspRootFromAnnotations,
} from "../src/index.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

describe("@hobo/wasp", () => {
	it("waspApp(root) is a thin marker; bindle attaches webapp annotation", () => {
		const definition = bindle((b) => {
			const db = b.container({ image: "postgres:16-alpine" });
			const web = b.web(waspApp("examples/wasp-opensaas/app")).dependsOn(db);
			return { db, web };
		});
		const root = waspRootFromAnnotations(
			must(definition.resources.web, "definition.resources.web").annotations,
		);
		expect(root).toBe("examples/wasp-opensaas/app");
		expect(
			definition.resources.web?.annotations.some(isWaspWebAppAnnotation),
		).toBe(true);
		expect(JSON.stringify(definition)).not.toMatch(/hobo\/opensaas-/u);
		expect(JSON.stringify(definition)).not.toMatch(/sourceUrl/u);
	});

	it("discoverWaspEnv reads OpenSaaS .env examples under the real app root", async () => {
		const discovered = await discoverWaspEnv(
			REPO_ROOT,
			"examples/wasp-opensaas/app",
		);
		expect(discovered.absRoot).toContain("examples/wasp-opensaas/app");
		expect(discovered.generalEnv).toContain("DATABASE_URL");
		expect(discovered.serverExampleKeys).toContain("STRIPE_API_KEY");
		expect(discovered.serverExampleKeys).toContain("AWS_S3_FILES_BUCKET");
		expect(discovered.suggestedDeps.some((d) => d.kind === "container")).toBe(
			true,
		);
		expect(discovered.suggestedDeps.some((d) => d.kind === "external")).toBe(
			true,
		);
	});
});
