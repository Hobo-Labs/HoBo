import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineCiProjectConfig } from "../src/project-config.js";
import { CiProjectDocumentSchema } from "../src/project-schema.js";
import {
	parseCiProjectSelection,
	resolveCiRelayRoute,
	type CiWebhookRoutingContext,
} from "../src/relay-routing.js";

describe("committed .hobo/ci.json routing", () => {
	const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
	const raw = readFileSync(`${repoRoot}/.hobo/ci.json`, "utf8");
	const document = CiProjectDocumentSchema.parse(JSON.parse(raw));
	const selection = parseCiProjectSelection(document);
	const config = defineCiProjectConfig({
		defaultEnvironment: "ci",
		environments: {
			local: document.environments?.local,
			ci: document.environments?.ci,
		},
	});

	it("commits main-branch selection to ci, not local", () => {
		const rules = selection?.rules ?? [];
		const mainRule = rules.find((rule) => rule.match?.branch === "main");
		expect(mainRule?.environment).toBe("ci");
	});

	it("routes main-branch pushes to ci, not local", () => {
		const context: CiWebhookRoutingContext = {
			repositoryFullName: "Hobo-Labs/HoBo",
			repositoryId: 1,
			installationId: 1,
			workflowRunId: 1,
			eventName: "push",
			headBranch: "main",
			headRef: "refs/heads/main",
			isForkPullRequest: false,
			configRef: "c".repeat(40),
		};
		const route = resolveCiRelayRoute({ config, selection, context });
		expect(route.environment.name).toBe("ci");
		expect(route.relayOrigin).toBe("https://hobo-ci.vercel.app");
	});

	it("does not select local without explicit environment override semantics", () => {
		expect(config.environments.local?.relayOrigin).toBe(
			"http://127.0.0.1:8787",
		);
		const context: CiWebhookRoutingContext = {
			repositoryFullName: "Hobo-Labs/HoBo",
			repositoryId: 1,
			installationId: 1,
			workflowRunId: 1,
			eventName: "push",
			headBranch: "feature/sandbox",
			headRef: "refs/heads/feature/sandbox",
			isForkPullRequest: false,
			configRef: "d".repeat(40),
		};
		const route = resolveCiRelayRoute({ config, selection, context });
		expect(route.environment.name).toBe("ci");
	});
});
