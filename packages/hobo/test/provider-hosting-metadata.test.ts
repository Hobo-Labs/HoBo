import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createClaimableOperationKeyDeriver,
	type HttpTransport,
	parseResolveOutcome,
	parseResolveRequest,
	type ResolveOutcome,
	type ResourceResolver,
	type TransportRequest,
} from "@hobo/core";
import { AWS_LAMBDA_PRODUCT_ID, awsResolverRegistry } from "@hobo/provider-aws";
import {
	AZURE_CONTAINER_APPS_PRODUCT_ID,
	azureResolverRegistry,
} from "@hobo/provider-azure";
import {
	DIGITALOCEAN_DROPLET_PRODUCT_ID,
	digitaloceanResolverRegistry,
} from "@hobo/provider-digitalocean";
import {
	GCP_CLOUD_RUN_PRODUCT_ID,
	gcpResolverRegistry,
} from "@hobo/provider-gcp";
import {
	HETZNER_CLOUD_SERVER_PRODUCT_ID,
	hetznerResolverRegistry,
} from "@hobo/provider-hetzner";
import {
	createNeonClaimableDatabaseDriver,
	createNeonClaimableResolver,
	createNeonClient,
	NEON_DEFINITION_ID,
	createInMemoryIdempotencyStore as neonStore,
} from "@hobo/provider-neon";
import {
	NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
	netlifyResolverRegistry,
} from "@hobo/provider-netlify";
import {
	createPrismaClaimableDatabaseDriver,
	createPrismaClaimableResolver,
	createPrismaClient,
	PRISMA_DEFINITION_ID,
	createInMemoryIdempotencyStore as prismaStore,
} from "@hobo/provider-prisma-postgres";
import {
	createUpstashClient,
	createUpstashTemporaryRedisDriver,
	createUpstashTemporaryRedisResolver,
	UPSTASH_DEFINITION_ID,
	createInMemoryIdempotencyStore as upstashStore,
} from "@hobo/provider-upstash";
import {
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
	vercelResolverRegistry,
} from "@hobo/provider-vercel";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableHostingMutationJournal } from "../src/hosting-mutation-journal.js";
import { createDurableHostingResourceRepository } from "../src/hosting-resource-store.js";
import type { JsonObject } from "../src/json.js";
import {
	type HostingProviderCatalogEntry,
	prepareHostingProviderDesired,
} from "../src/provider-hosting-catalog.js";

const graph = `sha256:${"c".repeat(64)}`;
const content = `sha256:${"a".repeat(64)}`;
const name = "hobo-target-incarnation";
const subscription = "11111111-2222-3333-4444-555555555555";
const dispose: (() => void)[] = [];
afterEach(() => {
	while (dispose.length) dispose.pop()?.();
});
const json = (body: JsonObject | JsonObject[], status = 200) => ({
	status,
	headers: {},
	body: JSON.stringify(body),
});

function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "hosting-metadata-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const store = createRuntimeLocalEventStore({
		dataDir,
		clock: createManualClock(),
	});
	dispose.push(() => store.close());
	const journal = createDurableHostingMutationJournal({
		store,
		tenantId: "tenant",
		actor: { kind: "service", id: "metadata-test" },
		fenceToken: 1n,
		nowMs: () => 1000,
	});
	return { journal, store };
}
function compiled(
	providerId: HostingProviderCatalogEntry["providerId"],
	productId: string,
	parameters: JsonObject,
	source = false,
) {
	const input = {
		productId,
		parameters,
		artifactId: graph,
		contentDigest: content,
		logicalId: name,
		operationId: `op-${providerId}`,
		ownershipRef: "tenant/deployment/incarnation/resource",
		source,
	};
	if (source)
		return prepareHostingProviderDesired(providerId, {
			...input,
			physicalId: "approved-native-id",
		});
	return prepareHostingProviderDesired(providerId, input);
}

describe("production catalog metadata reaches shipped native mutation contracts", () => {
	it.each([
		"aws",
		"azure",
		"gcp",
		"digitalocean",
		"hetzner",
		"netlify",
		"vercel",
	] as const)("compiles the %s mutation without foreign generic metadata or a reused native name", async (providerId) => {
		const { journal } = fixture();
		let productId: string;
		let parameters: JsonObject;
		let resolver: ResourceResolver | undefined;
		switch (providerId) {
			case "aws":
				productId = AWS_LAMBDA_PRODUCT_ID;
				parameters = {
					name: "old-name",
					image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/app@${content}`,
					executionRoleArn: "arn:aws:iam::123456789012:role/hosting",
					memoryMb: 512,
					timeoutSeconds: 30,
					reservedConcurrency: 2,
					architecture: "arm64",
				};
				resolver = awsResolverRegistry({
					region: "us-east-1",
					nowMs: 1000,
					resolveCredential: async () => ({
						accessKeyId: "AKIAEXAMPLEKEYID12345",
						secretAccessKey: "fixture-secret",
					}),
				}).get(productId);
				break;
			case "azure":
				productId = AZURE_CONTAINER_APPS_PRODUCT_ID;
				parameters = {
					name: "old-name",
					image: `registry.example/app@${content}`,
					location: "eastus",
					managedEnvironmentId: `/subscriptions/${subscription}/resourceGroups/hosting/providers/Microsoft.App/managedEnvironments/env`,
					ingress: "external",
					targetPort: 8080,
					cpu: 0.5,
					memory: "1Gi",
					minReplicas: 1,
					maxReplicas: 2,
				};
				resolver = azureResolverRegistry({
					subscriptionId: subscription,
					resourceGroup: "hosting",
					resolveCredential: async () => "token",
				}).get(productId);
				break;
			case "gcp":
				productId = GCP_CLOUD_RUN_PRODUCT_ID;
				parameters = {
					name: "old-name",
					location: "us-central1",
					image: `us-docker.pkg.dev/hosting-test/images/app@${content}`,
					serviceAccount: "hosting@hosting-test.iam.gserviceaccount.com",
					cpu: "1",
					memory: "512Mi",
					minInstances: 1,
					maxInstances: 2,
					concurrency: 10,
				};
				resolver = gcpResolverRegistry({
					projectId: "hosting-test",
					resolveCredential: async () => "token",
				}).get(productId);
				break;
			case "digitalocean":
				productId = DIGITALOCEAN_DROPLET_PRODUCT_ID;
				parameters = {
					name: "old-name",
					region: "nyc3",
					size: "s-1vcpu-1gb",
					image: "ubuntu-24-04-x64",
				};
				resolver = digitaloceanResolverRegistry({
					resolveCredential: async () => "token",
				}).get(productId);
				break;
			case "hetzner":
				productId = HETZNER_CLOUD_SERVER_PRODUCT_ID;
				parameters = {
					name: "old-name",
					location: "fsn1",
					serverType: "cx22",
					image: "ubuntu-24.04",
				};
				resolver = hetznerResolverRegistry({
					resolveCredential: async () => "token",
				}).get(productId);
				break;
			case "netlify":
				productId = NETLIFY_STATIC_DEPLOY_PRODUCT_ID;
				parameters = {
					siteId: "site-approved",
					files: { "/index.html": "approved bytes" },
				};
				resolver = netlifyResolverRegistry({
					accountId: "account",
					accountSlug: "team",
					mutationJournal: journal,
					resolveCredential: async () => "token",
				}).get(productId);
				break;
			case "vercel":
				productId = VERCEL_STATIC_DEPLOY_PRODUCT_ID;
				parameters = {
					name: "approved-site",
					projectId: "prj_approved",
					files: { "/index.html": "approved bytes" },
				};
				resolver = vercelResolverRegistry({
					teamId: "team_approved",
					mutationJournal: journal,
					resolveCredential: async () => "token",
				}).get(productId);
				break;
		}
		if (!resolver) throw new Error("shipped native resolver missing");
		const desired = compiled(providerId, productId, parameters);
		expect(desired.planDigest).toBeUndefined();
		const calls: TransportRequest[] = [];
		const transport: HttpTransport = async (call) => {
			calls.push(call);
			if (call.method !== "GET")
				throw new Error("native mutation dispatch reached");
			if (providerId === "digitalocean") return json({ droplets: [] });
			if (providerId === "hetzner") return json({ servers: [] });
			const path = new URL(call.url).pathname;
			if (providerId === "netlify")
				return path.endsWith("/deploys")
					? json([])
					: json({
							id: "site-approved",
							name: "approved-site",
							account_id: "account",
						});
			if (providerId === "vercel")
				return path.startsWith("/v9/projects/")
					? json({
							id: "prj_approved",
							accountId: "team_approved",
							framework: null,
						})
					: json({ deployments: [], pagination: {} });
			return json({}, 404);
		};
		await expect(
			resolver.reconcile(
				parseResolveRequest({
					ref: { slot: "service", productId, logicalId: name },
					desired,
					credentialRef: "vault://hosting/provider",
				}),
				transport,
			),
		).rejects.toThrow("native mutation dispatch reached");
		const mutations = calls.filter((call) => call.method !== "GET");
		expect(mutations).toHaveLength(1);
		const mutation = mutations[0];
		if (!mutation) throw new Error("native request missing");
		if (providerId === "netlify" || providerId === "vercel") {
			expect(desired.operationId).toBe(`op-${providerId}`);
			expect(desired.ownershipRef).toBeUndefined();
			expect(desired.artifactDigest).toBeUndefined();
			expect(
				providerId === "netlify" ? desired.siteId : desired.projectId,
			).toBe(providerId === "netlify" ? "site-approved" : "prj_approved");
		} else {
			expect(desired.ownershipRef).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(desired.artifactDigest).toBe(graph);
			expect(desired.operationId).toBeUndefined();
			expect(desired.name).toBe(name);
			expect(`${mutation.url}${mutation.body}`).toContain(name);
			expect(mutation.body).not.toContain("old-name");
		}
	});

	it.each([
		"neon",
		"prisma",
		"upstash",
	] as const)("routes compiled %s desired parameters through its actual allocation driver", async (providerId) => {
		const { store, journal } = fixture();
		const scope = {
			tenantId: "tenant",
			providerAccountId: "anonymous",
			scopeId: "deployment-incarnation",
		};
		const repository = createDurableHostingResourceRepository<ResolveOutcome>({
			store,
			scope: { ...scope, providerId },
			actor: { kind: "service", id: "metadata-test" },
			fenceToken: 1n,
			codec: {
				serialize: JSON.stringify,
				parse: (text) => parseResolveOutcome(parseJsonValue(text)),
			},
			nowMs: () => 1000,
		});
		const custody = { deposit: async () => "custody://allocation/credential" };
		const clock = () => 1000;
		let allocations = 0;
		const dispatch = async () => {
			allocations++;
			throw new Error("native allocation dispatch reached");
		};
		const common = {
			scope,
			repository,
			custody,
			journal,
			clock,
			deriveOperationKey: createClaimableOperationKeyDeriver(
				new Uint8Array(32).fill(7),
			),
			secretResolver: {
				resolve: async () => {
					throw new Error("no credential read expected before allocation");
				},
			},
		};
		let resolver: ResourceResolver;
		let productId: string;
		let parameters: JsonObject;
		if (providerId === "neon") {
			productId = NEON_DEFINITION_ID;
			parameters = { idempotencyKey: "author-key", ref: "hobo-validation" };
			resolver = createNeonClaimableResolver({
				...common,
				driver: createNeonClaimableDatabaseDriver({
					client: createNeonClient({
						transport: { request: dispatch },
						store: neonStore(),
						clock,
					}),
					custody,
					clock,
				}),
			});
		} else if (providerId === "prisma") {
			productId = PRISMA_DEFINITION_ID;
			parameters = { idempotencyKey: "author-key", ttl: "30m" };
			resolver = createPrismaClaimableResolver({
				...common,
				driver: createPrismaClaimableDatabaseDriver({
					client: createPrismaClient({
						runner: { run: dispatch },
						store: prismaStore(),
						clock,
					}),
					custody,
					clock,
				}),
			});
		} else {
			productId = UPSTASH_DEFINITION_ID;
			parameters = { idempotencyKey: "author-key" };
			resolver = createUpstashTemporaryRedisResolver({
				...common,
				driver: createUpstashTemporaryRedisDriver({
					client: createUpstashClient({
						transport: { request: dispatch },
						store: upstashStore(),
						clock,
					}),
					custody,
					clock,
				}),
			});
		}
		await expect(
			resolver.reconcile(
				parseResolveRequest({
					ref: { slot: "data", productId, logicalId: name },
					desired: compiled(providerId, productId, parameters),
					credentialRef: "vault://anonymous/provider",
				}),
				dispatch,
			),
		).rejects.toThrow("outcome is unconfirmed");
		expect(allocations).toBe(1);
	});

	it.each([
		"neon",
		"prisma",
		"upstash",
	] as const)("leaves the strict %s allocation parameters unchanged", (providerId) => {
		const parameters =
			providerId === "neon"
				? { idempotencyKey: "author-key", ref: "hobo-validation" }
				: { idempotencyKey: "author-key" };
		const result = compiled(providerId, `${providerId}.fixture/v1`, parameters);
		expect(result).toEqual(parameters);
		expect(result).not.toBe(parameters);
	});

	it("retains source names and rejects conflicting ownership or content markers", () => {
		expect(
			compiled("aws", AWS_LAMBDA_PRODUCT_ID, { name: "approved-source" }, true),
		).toEqual({ name: "approved-source" });
		expect(() =>
			prepareHostingProviderDesired("aws", {
				productId: AWS_LAMBDA_PRODUCT_ID,
				parameters: { name: "approved-source" },
				source: true,
				artifactId: graph,
				logicalId: "approved-source",
				ownershipRef: "tenant/deploy/incarnation/source",
				operationId: "source-read",
			}),
		).toThrow("pinned physical");
		expect(() =>
			compiled("aws", AWS_LAMBDA_PRODUCT_ID, {
				ownershipRef: `sha256:${"f".repeat(64)}`,
			}),
		).toThrow("conflicts");
		expect(() =>
			compiled("gcp", GCP_CLOUD_RUN_PRODUCT_ID, {
				image: `registry.example/app@sha256:${"f".repeat(64)}`,
			}),
		).toThrow("content digest");
		expect(() =>
			compiled("vercel", VERCEL_STATIC_DEPLOY_PRODUCT_ID, {
				projectId: "prj_approved",
				operationId: "foreign",
			}),
		).toThrow("conflicts");
	});
});
