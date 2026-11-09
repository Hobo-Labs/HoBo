import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createBoundedFetchTransport,
	createClaimableOperationKeyDeriver,
	type HttpTransport,
	parseResolveOutcome,
	parseResolveRequest,
	type ResolveOutcome,
} from "@hobo/core";
import { AWS_LAMBDA_PRODUCT_ID } from "@hobo/provider-aws";
import { AZURE_CONTAINER_APPS_PRODUCT_ID } from "@hobo/provider-azure";
import { CLOUDFLARE_WORKERS_PRODUCT_ID } from "@hobo/provider-cloudflare";
import {
	DIGITALOCEAN_DROPLET_PRODUCT_ID,
	DIGITALOCEAN_SPACES_PRODUCT_ID,
} from "@hobo/provider-digitalocean";
import { GCP_CLOUD_RUN_PRODUCT_ID } from "@hobo/provider-gcp";
import { HETZNER_CLOUD_SERVER_PRODUCT_ID } from "@hobo/provider-hetzner";
import { HOSTINGER_VPS_PRODUCT_ID } from "@hobo/provider-hostinger";
import { KUBERNETES_DEPLOYMENT_PRODUCT_ID } from "@hobo/provider-kubernetes";
import {
	createNeonClaimableDatabaseDriver,
	createNeonClient,
	NEON_DEFINITION_ID,
	createInMemoryIdempotencyStore as neonStore,
} from "@hobo/provider-neon";
import { NETLIFY_STATIC_DEPLOY_PRODUCT_ID } from "@hobo/provider-netlify";
import {
	createNodeProcessRunner,
	createPrismaClaimableDatabaseDriver,
	createPrismaClient,
	PRISMA_DEFINITION_ID,
	createInMemoryIdempotencyStore as prismaStore,
} from "@hobo/provider-prisma-postgres";
import { RAILWAY_SERVICE_PRODUCT_ID } from "@hobo/provider-railway";
import {
	createUpstashClient,
	createUpstashTemporaryRedisDriver,
	UPSTASH_DEFINITION_ID,
	createInMemoryIdempotencyStore as upstashStore,
} from "@hobo/provider-upstash";
import { VERCEL_STATIC_DEPLOY_PRODUCT_ID } from "@hobo/provider-vercel";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDurableHostingCredentialScopeReplayStore,
	createHostingCredentialScopeIssuer,
	createHostingCredentialScopeVerifier,
	createVerifiedHostingCredentialLease,
} from "../src/hosting-credential-scope.js";
import { createDurableHostingMutationJournal } from "../src/hosting-mutation-journal.js";
import { createDurableHostingResourceRepository } from "../src/hosting-resource-store.js";
import { isJsonString, parseJsonValue } from "../src/json.js";
import {
	createProductionHostingProviderCatalog,
	type HostingProviderCatalogEntry,
} from "../src/provider-hosting-catalog.js";

const dispose: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	while (dispose.length) await dispose.pop()?.();
});
const account = "account";
const cfAccount = "a".repeat(32);
const refuseIO = async () => {
	throw new Error("test has no live provider authorization");
};

function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "provider-hosting-catalog-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const store = createRuntimeLocalEventStore({
		dataDir,
		clock: createManualClock(),
	});
	dispose.push(() => store.close());
	const actor = { kind: "service", id: "catalog-test" } as const;
	const journal = createDurableHostingMutationJournal({
		store,
		tenantId: "tenant",
		actor,
		fenceToken: 1n,
		nowMs: () => 1000,
	});
	async function lease<T>(
		providerId: string,
		nativeAccountRef: string,
		material: T,
		tenantId = "tenant",
		providerAccountId = account,
		credentialVersion = "v1",
	) {
		const keys = generateKeyPairSync("ed25519");
		const identity = {
			tenantId,
			providerId,
			providerAccountId,
			nativeAccountRef,
		};
		const credentialRef = `vault://catalog/${providerId}/${tenantId}/${providerAccountId}`;
		const issuer = createHostingCredentialScopeIssuer({
			issuerId: "issuer",
			keyId: "key",
			privateKey: keys.privateKey,
			bindings: [
				{
					identity,
					credentialRef,
					credentialVersion,
					credential: material,
					evidenceRef: "inventory://native-account",
					observedAtMs: 900,
					validUntilMs: 100_000,
				},
			],
		});
		return createVerifiedHostingCredentialLease({
			request: {
				...identity,
				credentialRef,
				operationId: "initial",
				nowMs: 1000,
			},
			resolveCredential: async () => ({ version: credentialVersion, material }),
			attest: issuer.attest,
			verifier: createHostingCredentialScopeVerifier({
				trust: [
					{
						issuerId: "issuer",
						keyId: "key",
						publicKey: keys.publicKey,
						identities: [identity],
					},
				],
				replayStore: createDurableHostingCredentialScopeReplayStore({
					store,
					tenantId,
					actor,
					fenceToken: 1n,
				}),
				nowMs: () => 1000,
			}),
		});
	}
	function dataScope(providerId: string) {
		const scope = {
			tenantId: "tenant",
			providerAccountId: account,
			scopeId: "deployment-1",
		};
		return {
			scope,
			journal,
			clock: () => 1000,
			custody: { deposit: refuseIO },
			secretResolver: { resolve: refuseIO },
			repository: createDurableHostingResourceRepository<ResolveOutcome>({
				store,
				scope: { ...scope, providerId },
				actor,
				fenceToken: 1n,
				codec: {
					serialize: JSON.stringify,
					parse: (text) => parseResolveOutcome(parseJsonValue(text)),
				},
				nowMs: () => 1000,
			}),
		};
	}
	return { store, journal, lease, dataScope };
}

describe("production native provider catalog", () => {
	it("constructs all fourteen shipped native registries and explicit package aliases", async () => {
		const fx = fixture();
		const material = "captured-provider-token";
		const common = { transport: refuseIO, observeOperatingLiability: refuseIO };
		const neon = fx.dataScope("neon"),
			prisma = fx.dataScope("prisma"),
			upstash = fx.dataScope("upstash");
		const entries: HostingProviderCatalogEntry[] = [
			{
				providerId: "aws",
				lease: await fx.lease("aws", "aws://accounts/account", {
					accessKeyId: "test-key",
					secretAccessKey: "test-secret",
				}),
				options: { region: "us-east-1", nowMs: 1000 },
				...common,
			},
			{
				providerId: "azure",
				lease: await fx.lease(
					"azure",
					"azure://subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/hobo",
					material,
				),
				options: {
					subscriptionId: "11111111-1111-1111-1111-111111111111",
					resourceGroup: "hobo",
				},
				...common,
			},
			{
				providerId: "gcp",
				lease: await fx.lease("gcp", "gcp://projects/hobo-project", material),
				options: { projectId: "hobo-project" },
				...common,
			},
			{
				providerId: "cloudflare",
				lease: await fx.lease(
					"cloudflare",
					`cloudflare://accounts/${cfAccount}`,
					material,
				),
				options: { accountId: cfAccount },
				...common,
			},
			{
				providerId: "digitalocean",
				lease: await fx.lease(
					"digitalocean",
					"digitalocean://accounts/account",
					material,
				),
				options: {},
				...common,
			},
			{
				providerId: "hetzner",
				lease: await fx.lease(
					"hetzner",
					"hetzner://accounts/account",
					material,
				),
				options: {},
				...common,
			},
			{
				providerId: "hostinger",
				lease: await fx.lease(
					"hostinger",
					"hostinger://accounts/account",
					material,
				),
				options: {},
				...common,
			},
			{
				providerId: "kubernetes",
				lease: await fx.lease(
					"kubernetes",
					"kubernetes://clusters/https%3A%2F%2Fcluster.example",
					material,
				),
				options: { apiServerUrl: "https://cluster.example" },
				...common,
			},
			{
				providerId: "netlify",
				lease: await fx.lease(
					"netlify",
					"netlify://accounts/account",
					material,
				),
				options: {
					accountId: account,
					accountSlug: "hobo",
					mutationJournal: fx.journal,
				},
				...common,
			},
			{
				providerId: "vercel",
				lease: await fx.lease("vercel", "vercel://teams/team_hobo", material),
				options: { teamId: "team_hobo", mutationJournal: fx.journal },
				...common,
			},
			{
				providerId: "railway",
				lease: await fx.lease(
					"railway",
					"railway://projects/project-1/environments/environment-1",
					material,
				),
				options: {
					projectId: "project-1",
					environmentId: "environment-1",
					mutationJournal: fx.journal,
					deploymentStore: {
						store: fx.store,
						tenantId: "tenant",
						actor: { kind: "service", id: "catalog-test" },
						fenceToken: 1n,
						nowMs: () => 1000,
					},
				},
				...common,
			},
			{
				providerId: "neon",
				lease: await fx.lease("neon", "neon://accounts/account", material),
				options: {
					...neon,
					driver: createNeonClaimableDatabaseDriver({
						client: createNeonClient({
							transport: { request: refuseIO },
							store: neonStore(),
							clock: neon.clock,
						}),
						custody: neon.custody,
						clock: neon.clock,
					}),
				},
				...common,
			},
			{
				providerId: "prisma",
				lease: await fx.lease("prisma", "prisma://accounts/account", material),
				options: {
					...prisma,
					driver: createPrismaClaimableDatabaseDriver({
						client: createPrismaClient({
							runner: createNodeProcessRunner(),
							store: prismaStore(),
							clock: prisma.clock,
						}),
						custody: prisma.custody,
						clock: prisma.clock,
					}),
				},
				...common,
			},
			{
				providerId: "upstash",
				lease: await fx.lease(
					"upstash",
					"upstash://accounts/account",
					material,
				),
				options: {
					...upstash,
					driver: createUpstashTemporaryRedisDriver({
						client: createUpstashClient({
							transport: { request: refuseIO },
							store: upstashStore(),
							clock: upstash.clock,
						}),
						custody: upstash.custody,
						clock: upstash.clock,
					}),
				},
				...common,
			},
		];
		const catalog = createProductionHostingProviderCatalog(entries);
		expect(catalog.size).toBe(28);
		const products = [
			AWS_LAMBDA_PRODUCT_ID,
			AZURE_CONTAINER_APPS_PRODUCT_ID,
			GCP_CLOUD_RUN_PRODUCT_ID,
			CLOUDFLARE_WORKERS_PRODUCT_ID,
			DIGITALOCEAN_DROPLET_PRODUCT_ID,
			HETZNER_CLOUD_SERVER_PRODUCT_ID,
			HOSTINGER_VPS_PRODUCT_ID,
			KUBERNETES_DEPLOYMENT_PRODUCT_ID,
			NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
			VERCEL_STATIC_DEPLOY_PRODUCT_ID,
			RAILWAY_SERVICE_PRODUCT_ID,
			NEON_DEFINITION_ID,
			PRISMA_DEFINITION_ID,
			UPSTASH_DEFINITION_ID,
		];
		for (const [index, entry] of entries.entries()) {
			const manifest =
				entry.providerId === "prisma"
					? "@hobo/provider-prisma-postgres"
					: `@hobo/provider-${entry.providerId}`;
			const binding = catalog.get(entry.providerId);
			expect(binding).toBe(catalog.get(manifest));
			expect(binding?.prepareDesired).toBeInstanceOf(Function);
			expect(
				binding?.registry.get(products[index]),
				`${entry.providerId}:${products[index]}`,
			).toBeDefined();
			expect(binding?.registry.get("unsupported.product/v1")).toBeUndefined();
			await binding?.verifyCredentialScope({
				tenantId: "tenant",
				providerId: manifest,
				providerAccountId: account,
				credentialRef: binding.credentialRef,
				operationId: "prepare",
				nowMs: 1000,
			});
		}
		expect(catalog.has("@hobo/provider-prisma")).toBe(false);
	});

	it("keeps native scope and material fixed across actual HTTP requests and phase changes", async () => {
		const fx = fixture();
		const calls: { path: string; authorization: string }[] = [];
		let uploaded: { source: string } | undefined;
		let contentReadbacks = 0;
		const server = createServer((request, response) => {
			const path = request.url ?? "";
			calls.push({ path, authorization: request.headers.authorization ?? "" });
			response.setHeader("content-type", "application/json");
			if (request.method === "PUT") {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk) => {
					body += String(chunk);
				});
				request.on("end", () => {
					const source = body
						.split("Content-Type: application/javascript+module\r\n\r\n")[1]
						?.split("\r\n--")[0];
					if (source === undefined) {
						response.statusCode = 400;
						response.end(
							JSON.stringify({
								success: false,
								errors: [{ message: "invalid module upload" }],
							}),
						);
						return;
					}
					uploaded = { source };
					response.end(
						JSON.stringify({ success: true, result: { id: "app" } }),
					);
				});
				return;
			}
			if (request.method === "GET" && uploaded) {
				if (path.endsWith("/settings"))
					response.end(
						JSON.stringify({
							success: true,
							result: { id: "app", bindings: [] },
						}),
					);
				else if (path.endsWith("/subdomain"))
					response.end(
						JSON.stringify({
							success: true,
							result: { enabled: false, previews_enabled: false },
						}),
					);
				else {
					contentReadbacks++;
					response.setHeader(
						"content-type",
						"multipart/form-data; boundary=native-observed",
					);
					response.end(
						`--native-observed\r\nContent-Disposition: form-data; name="worker.js"\r\n\r\n${uploaded.source}\r\n--native-observed--\r\n`,
					);
				}
				return;
			}
			response.statusCode = 404;
			response.end(
				JSON.stringify({ success: false, errors: [{ code: 10007 }] }),
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		dispose.push(
			() =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
		);
		const address = server.address();
		if (!address || isJsonString(address))
			throw new Error("fixture address missing");
		const bounded = createBoundedFetchTransport({
			fetchImpl: globalThis.fetch,
		});
		const transport: HttpTransport = (request) =>
			bounded({
				...request,
				url: `http://127.0.0.1:${address.port}${new URL(request.url).pathname}`,
			});
		const entry = {
			providerId: "cloudflare" as const,
			lease: await fx.lease(
				"cloudflare",
				`cloudflare://accounts/${cfAccount}`,
				"original-captured-token",
			),
			options: { accountId: cfAccount },
			transport,
			observeOperatingLiability: refuseIO,
		};
		const catalog = createProductionHostingProviderCatalog([entry]);
		entry.options.accountId = "b".repeat(32);
		entry.lease = await fx.lease(
			"cloudflare",
			`cloudflare://accounts/${cfAccount}`,
			"replacement-token",
			"tenant",
			account,
			"v2",
		);
		const binding = catalog.get("cloudflare");
		if (!binding) throw new Error("fixture missing catalog binding");
		for (const operationId of ["prepare", "shift"]) {
			await binding.verifyCredentialScope({
				tenantId: "tenant",
				providerId: "cloudflare",
				providerAccountId: account,
				credentialRef: binding.credentialRef,
				operationId,
				nowMs: 1000,
			});
			const resolver = binding.registry.get(CLOUDFLARE_WORKERS_PRODUCT_ID);
			if (!resolver) throw new Error("fixture missing shipped resolver");
			await resolver.reconcile(
				parseResolveRequest({
					ref: {
						slot: "service",
						productId: CLOUDFLARE_WORKERS_PRODUCT_ID,
						logicalId: "app",
					},
					desired:
						binding.prepareDesired?.({
							productId: CLOUDFLARE_WORKERS_PRODUCT_ID,
							source: false,
							logicalId: "app",
							artifactId: `sha256:${"a".repeat(64)}`,
							operationId,
							ownershipRef: "tenant/deploy/incarnation/app",
							parameters: {
								script:
									"export default {fetch(){return new Response('catalog')}}",
							},
						}) ?? {},
					credentialRef: binding.credentialRef,
				}),
				binding.transport,
			);
		}
		expect(calls.length).toBeGreaterThan(1);
		expect(contentReadbacks).toBeGreaterThanOrEqual(2);
		expect(
			calls.every(
				(call) =>
					call.authorization === "Bearer original-captured-token" &&
					call.path.includes(`/accounts/${cfAccount}/`),
			),
		).toBe(true);
	});

	it("requires a private pinned host key for anonymous native identities and overrides injected derivation callbacks", async () => {
		const fx = fixture();
		const common = fx.dataScope("upstash");
		const nativeKeys: string[] = [];
		let unverifiedCalls = 0;
		const nativeTransport = {
			request: async (request: {
				readonly headers: Readonly<Record<string, string>>;
			}) => {
				nativeKeys.push(request.headers["idempotency-key"] ?? "");
				throw new Error("native create response unknown");
			},
		};
		const driver = createUpstashTemporaryRedisDriver({
			client: createUpstashClient({
				transport: nativeTransport,
				store: upstashStore(),
				clock: common.clock,
			}),
			custody: common.custody,
			clock: common.clock,
		});
		const options = {
			...common,
			driver,
			deriveOperationKey: async () => {
				unverifiedCalls++;
				return "00000000-0000-4000-8000-000000000000";
			},
		};
		const entry = {
			providerId: "upstash" as const,
			lease: await fx.lease(
				"upstash",
				"upstash://accounts/account",
				"anonymous",
			),
			options,
			observeOperatingLiability: refuseIO,
		};
		const rejected = createProductionHostingProviderCatalog([entry]).get(
			"upstash",
		);
		if (!rejected) throw new Error("fixture missing binding");
		const request = parseResolveRequest({
			ref: {
				slot: "data",
				productId: UPSTASH_DEFINITION_ID,
				logicalId: "redis",
			},
			desired: { idempotencyKey: "author-seed" },
			credentialRef: rejected.credentialRef,
		});
		const rejectedResolver = rejected.registry.get(UPSTASH_DEFINITION_ID);
		if (!rejectedResolver) throw new Error("fixture missing actual resolver");
		const refused = rejectedResolver.reconcile(request, refuseIO);
		await expect(refused).rejects.toHaveProperty(
			"message",
			"private operation-key derivation is unavailable",
		);
		await expect(refused).rejects.not.toHaveProperty("cause");
		expect(nativeKeys).toHaveLength(0);
		const key = new Uint8Array(32).fill(23);
		entry.lease = await fx.lease(
			"upstash",
			"upstash://accounts/account",
			Buffer.from(key).toString("base64url"),
			"tenant",
			account,
			"v2",
		);
		const binding = createProductionHostingProviderCatalog([entry]).get(
			"upstash",
		);
		if (!binding) throw new Error("fixture missing private binding");
		entry.lease = await fx.lease(
			"upstash",
			"upstash://accounts/account",
			Buffer.from(new Uint8Array(32).fill(29)).toString("base64url"),
			"tenant",
			account,
			"v3",
		);
		const resolver = binding.registry.get(UPSTASH_DEFINITION_ID);
		if (!resolver) throw new Error("fixture missing actual Redis resolver");
		const pinned = { ...request, credentialRef: binding.credentialRef };
		await expect(resolver.reconcile(pinned, refuseIO)).rejects.toThrow(
			"outcome is unconfirmed",
		);
		expect(nativeKeys).toEqual([
			await createClaimableOperationKeyDeriver(key)(common.scope, pinned),
		]);
		expect(unverifiedCalls).toBe(0);
		const events = [];
		for await (const event of fx.store.readAll()) events.push(event.event.data);
		expect(JSON.stringify(events)).not.toContain(nativeKeys[0]);
	});

	it("does not accept unverified auxiliary callbacks hidden in a native options object", async () => {
		const fx = fixture();
		let callbackCalls = 0,
			outboundCalls = 0;
		const options = {
			nowMs: 1000,
			resolveSpacesCredential: async () => {
				callbackCalls++;
				return {
					accessKeyId: "unverified",
					secretAccessKey: "unverified-secret",
				};
			},
		};
		const lease = await fx.lease(
			"digitalocean",
			"digitalocean://accounts/account",
			"token",
		);
		const binding = createProductionHostingProviderCatalog([
			{
				providerId: "digitalocean",
				lease,
				options,
				observeOperatingLiability: refuseIO,
				transport: async () => {
					outboundCalls++;
					return refuseIO();
				},
			},
		]).get("digitalocean");
		const resolver = binding?.registry.get(DIGITALOCEAN_SPACES_PRODUCT_ID);
		if (!resolver || !binding)
			throw new Error("fixture missing Spaces resolver");
		await expect(
			resolver.reconcile(
				parseResolveRequest({
					ref: {
						slot: "bucket",
						productId: DIGITALOCEAN_SPACES_PRODUCT_ID,
						logicalId: "bucket",
					},
					desired: { region: "nyc3" },
					credentialRef: binding.credentialRef,
				}),
				binding.transport,
			),
		).rejects.toThrow("independently enrolled");
		expect(callbackCalls).toBe(0);
		expect(outboundCalls).toBe(0);
	});

	it("refuses native scope, secondary account, and claimable tenant tampering before IO", async () => {
		const fx = fixture();
		const lease = await fx.lease(
			"cloudflare",
			`cloudflare://accounts/${cfAccount}`,
			"token",
		);
		expect(() =>
			createProductionHostingProviderCatalog([
				{
					providerId: "cloudflare",
					lease,
					options: { accountId: "b".repeat(32) },
					observeOperatingLiability: refuseIO,
				},
			]),
		).toThrow("native scope");
		const primary = await fx.lease(
			"hostinger",
			"hostinger://accounts/account",
			"token",
		);
		const foreign = await fx.lease(
			"hostinger",
			"hostinger://accounts/foreign",
			"password",
			"tenant",
			"foreign",
		);
		expect(() =>
			createProductionHostingProviderCatalog([
				{
					providerId: "hostinger",
					lease: primary,
					options: {},
					databasePasswordLeases: new Map([["db", foreign]]),
					observeOperatingLiability: refuseIO,
				},
			]),
		).toThrow("secondary credential");
		const neon = fx.dataScope("neon");
		const driver = createNeonClaimableDatabaseDriver({
			client: createNeonClient({
				transport: { request: refuseIO },
				store: neonStore(),
				clock: neon.clock,
			}),
			custody: neon.custody,
			clock: neon.clock,
		});
		expect(() =>
			createProductionHostingProviderCatalog([
				{
					providerId: "neon",
					lease: primary,
					options: {
						...neon,
						driver,
						scope: { ...neon.scope, tenantId: "foreign" },
					},
					observeOperatingLiability: refuseIO,
				},
			]),
		).toThrow("claimable resolver scope");
	});

	it("refuses changed tenant or a guessed provider alias before new scope proofs", async () => {
		const fx = fixture();
		const lease = await fx.lease(
			"cloudflare",
			`cloudflare://accounts/${cfAccount}`,
			"token",
		);
		const binding = createProductionHostingProviderCatalog([
			{
				providerId: "cloudflare",
				lease,
				options: { accountId: cfAccount },
				observeOperatingLiability: refuseIO,
			},
		]).get("cloudflare");
		if (!binding) throw new Error("fixture missing binding");
		const input = {
			tenantId: "tenant",
			providerId: "cloudflare",
			providerAccountId: account,
			credentialRef: binding.credentialRef,
			operationId: "prepare",
			nowMs: 1000,
		};
		await expect(
			binding.verifyCredentialScope({ ...input, tenantId: "foreign" }),
		).rejects.toThrow("operation scope");
		await expect(
			binding.verifyCredentialScope({
				...input,
				providerId: "provider-cloudflare",
			}),
		).rejects.toThrow("explicit catalog alias");
		expect(() =>
			createProductionHostingProviderCatalog([
				{
					providerId: "cloudflare",
					lease,
					options: { accountId: cfAccount },
					observeOperatingLiability: refuseIO,
				},
				{
					providerId: "cloudflare",
					lease,
					options: { accountId: cfAccount },
					observeOperatingLiability: refuseIO,
				},
			]),
		).toThrow("duplicate");
	});
});
