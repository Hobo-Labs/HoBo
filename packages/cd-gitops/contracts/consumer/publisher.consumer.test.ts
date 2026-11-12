import { ReconcileStatus } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import { createGitopsPublisher } from "../../src/index.js";
import {
	config,
	credentials,
	ctx,
	publishInput,
	set,
} from "../../test/fixtures.js";
import { loadPact, pactTransport } from "./pact-transport.js";

// Consumer side of the Git host and engine boundaries. Each pact pins the
// exact calls a first publish makes (no files yet → one commit) and the
// engine status shapes the publisher must interpret.
const signal = new AbortController().signal;
const NEW = "9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5";

const HOSTS = [
	["cd_gitops_github", "GIT_HOST_GITHUB"],
	["cd_gitops_gitlab", "GIT_HOST_GITLAB"],
	["cd_gitops_gitea", "GIT_HOST_GITEA"],
	["cd_gitops_bitbucket", "GIT_HOST_BITBUCKET"],
] as const;

describe("Git host boundaries (consumer side of the pacts)", () => {
	for (const [name, host] of HOSTS) {
		it(`${name}: a first publish commits both documents in one commit`, async () => {
			const pact = loadPact(name);
			const http = pactTransport(pact.interactions);
			const port = createGitopsPublisher({
				config: config("GITOPS_ENGINE_ARGO_CD", host),
				http,
				credentials: credentials(),
			});
			const result = await port.publish(publishInput(), ctx);
			expect(result).toEqual({ ok: true, value: { revision: NEW } });
			expect(http.served()).toBe(pact.interactions.length);
		});
	}
});

const ENGINES = [
	["cd_gitops_argocd", "GITOPS_ENGINE_ARGO_CD"],
	["cd_gitops_flux", "GITOPS_ENGINE_FLUX"],
] as const;

const EXPECTED = new Map<string, ReconcileStatus>(
	Object.entries({
		converged: ReconcileStatus.CONVERGED,
		converging: ReconcileStatus.CONVERGING,
		blocked: ReconcileStatus.BLOCKED,
		missing: ReconcileStatus.CONVERGING,
	}),
);

describe("engine status boundaries (consumer side of the pacts)", () => {
	for (const [name, engine] of ENGINES) {
		for (const interaction of loadPact(name).interactions) {
			it(`${name}: ${interaction.description}`, async () => {
				const http = pactTransport([interaction]);
				const port = createGitopsPublisher({
					config: config(engine),
					http,
					credentials: credentials(),
				});
				const observation = await port.observe(
					{ set, revision: NEW, signal },
					ctx,
				);
				expect(observation.status).toBe(
					EXPECTED.get(interaction.providerState ?? ""),
				);
				if (observation.status !== ReconcileStatus.CONVERGED)
					expect(observation.reasons).toHaveLength(1);
				expect(http.served()).toBe(1);
			});
		}
	}
});
