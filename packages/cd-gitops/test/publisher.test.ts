import { ReconcileStatus } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import {
	createGitopsPublisher,
	createPublisherRegistry,
	GITOPS_FAILURES,
	parsePublisherConfig,
	publisherTarget,
	renderPublication,
} from "../src/index.js";
import {
	config,
	credentials,
	ctx,
	fakeGitHub,
	json,
	NOW,
	publishInput,
	resolved,
	routes,
	set,
} from "./fixtures.js";

const signal = new AbortController().signal;

describe("GitOps publisher — publish", () => {
	it("commits the rendered documents in one commit and returns its revision", async () => {
		const git = fakeGitHub();
		const port = createGitopsPublisher({
			config: config(),
			http: git.http,
			credentials: credentials(),
		});
		const result = await port.publish(publishInput(), ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.revision).toBe(git.head());
		const rendered = renderPublication(config(), set, resolved);
		for (const file of rendered.files)
			expect(git.files().get(file.path)).toBe(file.content);
		expect(git.commitCount()).toBe(1);
		expect(port.target).toBe("argo-cd:github:acme/deploy@main/hobo/camps");
	});

	it("is idempotent: publishing the same Set again makes no commit and returns the head", async () => {
		const git = fakeGitHub();
		const port = createGitopsPublisher({
			config: config(),
			http: git.http,
			credentials: credentials(),
		});
		const first = await port.publish(publishInput(), ctx);
		const second = await port.publish(publishInput(), ctx);
		expect(second).toEqual(first);
		expect(git.commitCount()).toBe(1);
	});

	it("retries once from the new head when the branch moved", async () => {
		const git = fakeGitHub({ moveBranchOnce: true });
		const port = createGitopsPublisher({
			config: config(),
			http: git.http,
			credentials: credentials(),
		});
		const result = await port.publish(publishInput(), ctx);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.revision).toBe(git.head());
	});

	it("refuses with a typed, remediated reason when the host refuses the token", async () => {
		const http = routes({
			"GET /repos/acme/deploy/git/ref/heads/main": () =>
				json(401, { message: "Bad credentials" }),
		});
		const port = createGitopsPublisher({
			config: config(),
			http,
			credentials: credentials(),
		});
		const result = await port.publish(publishInput(), ctx);
		expect(result).toEqual({
			ok: false,
			reasons: [
				expect.objectContaining({
					code: "gitops-host-auth-failed",
					remediation: GITOPS_FAILURES["gitops-host-auth-failed"].remediation,
					subject: "prod",
				}),
			],
		});
	});

	it("never sends a request without a credential and never records the token", async () => {
		const http = routes({});
		const port = createGitopsPublisher({
			config: config(),
			http,
			credentials: credentials({}),
		});
		const result = await port.publish(publishInput(), ctx);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reasons[0]?.code).toBe("gitops-credential-missing");
		expect(http.requests).toHaveLength(0);
		const git = fakeGitHub();
		const ok = await createGitopsPublisher({
			config: config(),
			http: git.http,
			credentials: credentials(),
		}).publish(publishInput(), ctx);
		expect(JSON.stringify(ok)).not.toContain("git-token");
		for (const content of git.files().values())
			expect(content).not.toContain("git-token");
	});

	it("maps transport failure to gitops-host-unavailable", async () => {
		const http = async () => {
			throw new Error("ECONNREFUSED");
		};
		const port = createGitopsPublisher({
			config: config(),
			http,
			credentials: credentials(),
		});
		const result = await port.publish(publishInput(), ctx);
		if (result.ok) throw new Error("expected refusal");
		expect(result.reasons[0]?.code).toBe("gitops-host-unavailable");
	});
});

describe("GitOps publisher — convergence only on observation", () => {
	const argoApp = (sync: string, health: string, revision: string) =>
		json(200, {
			status: { sync: { status: sync, revision }, health: { status: health } },
		});
	const observe = async (
		reply: () => ReturnType<typeof json>,
		engine:
			| "GITOPS_ENGINE_ARGO_CD"
			| "GITOPS_ENGINE_FLUX" = "GITOPS_ENGINE_ARGO_CD",
	) => {
		const path =
			engine === "GITOPS_ENGINE_ARGO_CD"
				? "GET /api/v1/applications/hobo-prod?appNamespace=argocd"
				: "GET /apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/hobo-prod";
		const http = routes({ [path]: reply });
		const port = createGitopsPublisher({
			config: config(engine),
			http,
			credentials: credentials(),
		});
		return port.observe({ set, revision: "abc1234", signal }, ctx);
	};

	it("a successful commit alone is not convergence: the engine must report the revision", async () => {
		const git = fakeGitHub();
		const port = createGitopsPublisher({
			config: config(),
			http: git.http,
			credentials: credentials(),
		});
		await port.publish(publishInput(), ctx);
		// The engine has not been observed (status API unreachable here).
		const observation = await port.observe(
			{ set, revision: git.head(), signal },
			ctx,
		);
		expect(observation.status).toBe(ReconcileStatus.CONVERGING);
		expect(observation.reasons[0]?.code).toBe("gitops-engine-unobservable");
	});

	it("CONVERGED only when synced to exactly the published revision and healthy", async () => {
		const done = await observe(() => argoApp("Synced", "Healthy", "abc1234"));
		expect(done.status).toBe(ReconcileStatus.CONVERGED);
		expect(done.campId).toBe("prod");
		expect(done.setId).toBe(set.setId);
		expect(done.observedAt).toBe(new Date(NOW).toISOString());
		expect(done.resources[0]).toMatchObject({
			resource: "hobo-prod",
			healthy: true,
			outputsHash: "abc1234",
			kind: "Application",
		});
		expect(
			(await observe(() => argoApp("Synced", "Healthy", "0ld0000"))).status,
		).toBe(ReconcileStatus.CONVERGING);
		expect(
			(await observe(() => argoApp("OutOfSync", "Healthy", "abc1234"))).status,
		).toBe(ReconcileStatus.CONVERGING);
		expect(
			(await observe(() => argoApp("Synced", "Progressing", "abc1234"))).status,
		).toBe(ReconcileStatus.CONVERGING);
	});

	it("BLOCKED when the engine reports the revision degraded or failed", async () => {
		const degraded = await observe(() =>
			argoApp("Synced", "Degraded", "abc1234"),
		);
		expect(degraded.status).toBe(ReconcileStatus.BLOCKED);
		expect(degraded.reasons[0]?.code).toBe("gitops-engine-degraded");
	});

	it("an unreadable or missing engine document is never convergence", async () => {
		const missing = await observe(() => json(404, { message: "not found" }));
		expect(missing.status).toBe(ReconcileStatus.CONVERGING);
		expect(missing.reasons[0]?.code).toBe("gitops-engine-not-found");
		const down = await observe(() => json(503, {}));
		expect(down.status).toBe(ReconcileStatus.CONVERGING);
		expect(down.reasons[0]?.code).toBe("gitops-engine-unobservable");
		const garbage = await observe(() => ({
			status: 200,
			headers: {},
			body: "<html>",
		}));
		expect(garbage.status).toBe(ReconcileStatus.CONVERGING);
	});

	it("observes Flux through the Kustomization status", async () => {
		const flux = (ready: string, applied: string, attempted = applied) =>
			json(200, {
				metadata: { generation: 2 },
				status: {
					observedGeneration: 2,
					lastAppliedRevision: applied,
					lastAttemptedRevision: attempted,
					conditions: [
						{
							type: "Ready",
							status: ready,
							reason:
								ready === "True"
									? "ReconciliationSucceeded"
									: "HealthCheckFailed",
							message: "m",
						},
					],
				},
			});
		expect(
			(
				await observe(
					() => flux("True", "main@sha1:abc1234"),
					"GITOPS_ENGINE_FLUX",
				)
			).status,
		).toBe(ReconcileStatus.CONVERGED);
		expect(
			(
				await observe(
					() => flux("True", "main@sha1:0ld0000"),
					"GITOPS_ENGINE_FLUX",
				)
			).status,
		).toBe(ReconcileStatus.CONVERGING);
		expect(
			(
				await observe(
					() => flux("False", "main@sha1:0ld0000", "main@sha1:abc1234"),
					"GITOPS_ENGINE_FLUX",
				)
			).status,
		).toBe(ReconcileStatus.BLOCKED);
	});

	it("a missing engine credential is BLOCKED with remediation, not converged", async () => {
		const http = routes({});
		const port = createGitopsPublisher({
			config: config(),
			http,
			credentials: credentials({ "git/acme-deploy": "t" }),
		});
		const observation = await port.observe(
			{ set, revision: "abc1234", signal },
			ctx,
		);
		expect(observation.status).toBe(ReconcileStatus.BLOCKED);
		expect(observation.reasons[0]?.code).toBe("gitops-credential-missing");
	});
});

describe("publisher registry", () => {
	it("legacy Argo policy still delivers via the publisher (argo-cd target)", async () => {
		const git = fakeGitHub();
		const argo = config("GITOPS_ENGINE_ARGO_CD");
		const registry = createPublisherRegistry([
			{
				config: argo,
				port: createGitopsPublisher({
					config: argo,
					http: git.http,
					credentials: credentials(),
				}),
			},
		]);
		// A broker DeliveryPolicy with the deprecated engine "argo" parses to
		// publisher target "argo-cd" (@hobo/broker LEGACY_ARGO_PUBLISHER).
		const found = registry.get("argo-cd");
		expect(found.ok).toBe(true);
		if (!found.ok) return;
		const published = await found.value.publish(publishInput(), ctx);
		expect(published.ok).toBe(true);
		expect(
			git.files().has("hobo/camps/camp-prod/argo-cd.application.json"),
		).toBe(true);
		const unknown = registry.get("spinnaker");
		expect(unknown.ok).toBe(false);
		if (!unknown.ok)
			expect(unknown.reasons[0]?.code).toBe("gitops-publisher-unknown");
		expect(registry.names()).toEqual(["argo-cd"]);
	});

	it("names the publish target", () => {
		expect(
			publisherTarget(config("GITOPS_ENGINE_FLUX", "GIT_HOST_GITLAB")),
		).toBe("flux:gitlab:acme/deploy@main/hobo/camps");
	});
});

describe("parsePublisherConfig", () => {
	const valid = {
		schemaVersion: "hobo.cd-gitops.publisher/v1",
		name: "flux",
		engine: "GITOPS_ENGINE_FLUX",
		repository: {
			host: "GIT_HOST_GITEA",
			apiBaseUrl: "https://forge.example/api/v1/",
			repository: "acme/deploy",
			branch: "main",
			pathPrefix: "hobo",
			cloneUrl: "https://forge.example/acme/deploy.git",
			credentialRef: "git",
		},
		endpoint: {
			apiBaseUrl: "https://kube.example:6443",
			credentialRef: "kube",
		},
	};

	it("fills defaults and trims trailing slashes", () => {
		const parsed = parsePublisherConfig(valid);
		expect(parsed.repository.apiBaseUrl).toBe("https://forge.example/api/v1");
		expect(parsed.endpoint.namespace).toBe("flux-system");
		expect(parsed.endpoint.destinationNamespace).toBe("hobo-system");
		expect(parsed.endpoint.sourceRef).toBe("hobo");
		expect(parsed.interval).toBe("1m");
	});

	it.each([
		[
			"http API",
			{
				repository: { ...valid.repository, apiBaseUrl: "http://forge.example" },
			},
		],
		[
			"credentials in URL",
			{
				repository: {
					...valid.repository,
					cloneUrl: "https://u:p@forge.example/r.git",
				},
			},
		],
		[
			"dot-dot prefix",
			{ repository: { ...valid.repository, pathPrefix: "hobo/../etc" } },
		],
		[
			"absolute prefix",
			{ repository: { ...valid.repository, pathPrefix: "/hobo" } },
		],
		["bad branch", { repository: { ...valid.repository, branch: "a..b" } }],
		[
			"bad repository",
			{ repository: { ...valid.repository, repository: "deploy" } },
		],
		[
			"missing credential",
			{ endpoint: { ...valid.endpoint, credentialRef: "" } },
		],
		[
			"bad namespace",
			{ endpoint: { ...valid.endpoint, namespace: "Flux_System" } },
		],
		["unknown engine", { engine: "GITOPS_ENGINE_UNSPECIFIED" }],
		["wrong schema", { schemaVersion: "v0" }],
		["bad interval", { interval: "soon" }],
	])("refuses %s", (_label, override) => {
		expect(() => parsePublisherConfig({ ...valid, ...override })).toThrow(
			/gitops-config-invalid/,
		);
	});
});
