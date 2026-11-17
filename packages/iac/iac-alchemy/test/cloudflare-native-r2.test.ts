import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Namespace } from "@alchemy.run/cloudflare/KV/Namespace";
import { Providers } from "@alchemy.run/cloudflare/Providers";
import { Bucket } from "@alchemy.run/cloudflare/R2/Bucket";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import type { ResourceClass } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	describeAlchemyPrimitiveSupport,
	mapBindleToAlchemy,
} from "../src/bindle.js";
import {
	cloudflareKvNamespaceClaim,
	cloudflareKvProxySource,
} from "../src/cloudflare-native-kv.js";
import {
	cloudflareNativeR2BindleMappers,
	cloudflareR2BucketClaim,
	cloudflareR2ProxySource,
} from "../src/cloudflare-native-r2.js";
import {
	cloudflareDependencyBindings,
	inspectCloudflareWorker,
	withCloudflareEventualKv,
	withCloudflareR2,
} from "../src/cloudflare-runtime.js";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { hashAlchemyPriorState } from "../src/plan.js";
import worker, {
	application,
	grant,
	neutralApplication,
} from "./fixtures/cloudflare-r2-app.js";
import { routeFixture, testOperation } from "./route-fixture.js";

const main = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/cloudflare-r2-app.ts",
);
const proxySource = cloudflareR2ProxySource("r2-app", "assets", {
	...grant,
	allow: ["read"],
});
const bucketClaim = cloudflareR2BucketClaim(
	"r2-app",
	"assets",
	grant.bucketEpoch,
);
const appSource = {
	resourceId: "web",
	resourceType: "Cloudflare.Worker",
	bindleName: "r2-app",
	applicationName: "web",
	sourceKind: "worker",
	sourcePath: main,
};
const sourceRequirements = [proxySource, appSource];
const sourceFence = {
	sourceDigest: `sha256:${"a".repeat(64)}`,
	environmentDigest: `sha256:${"b".repeat(64)}`,
	proofRef: "test:host",
	verify: (claim: typeof proxySource) =>
		sourceRequirements.some(
			(source) =>
				JSON.stringify(source) ===
				JSON.stringify({
					resourceId: claim.resourceId,
					resourceType: claim.resourceType,
					bindleName: claim.bindleName,
					applicationName: claim.applicationName,
					sourceKind: claim.sourceKind,
					sourcePath: claim.sourcePath,
				}),
		),
};
function assessRequirements(requirements: {
	readonly require: readonly string[];
	readonly runtimes: readonly string[];
}) {
	return JSON.stringify(requirements.require) ===
		JSON.stringify(["blob-bounded-objects", "http"]) &&
		JSON.stringify(requirements.runtimes) === JSON.stringify(["javascript"])
		? { status: "supported" as const }
		: {
				status: "unsupported" as const,
				reason: "only bounded JavaScript objects are available",
			};
}
const allowed = (options: { bucket?: boolean; grant?: boolean } = {}) =>
	cloudflareNativeR2BindleMappers({
		workerModules: { web: main },
		sourceFence,
		verifyBucket: (claim) =>
			options.bucket !== false &&
			JSON.stringify(claim) === JSON.stringify(bucketClaim),
		verifyGrant: (claim) =>
			options.grant !== false &&
			claim.proxyResourceId === proxySource.resourceId &&
			claim.grantEpoch === grant.grantEpoch &&
			JSON.stringify(claim.allow) === JSON.stringify(["read"]),
	});

describe("Cloudflare R2 Bindle mapping", () => {
	it("keeps the original Bindle neutral, requires a grant, and discloses partial primitive coverage", () => {
		expect(neutralApplication.resources.assets?.annotations).toEqual([]);
		expect(application.resources.assets?.annotations).toMatchObject([
			{ provider: "cloudflare", option: "bounded-r2" },
		]);
		const report = describeAlchemyPrimitiveSupport(
			[{ factory: "bucket", allowVerbs: ["read", "write", "delete"] }],
			allowed(),
		);
		expect(report[0]).toMatchObject({
			status: "partial",
			resourceTypes: ["Cloudflare.R2.Bucket", "Cloudflare.Worker"],
			supportedOperations: ["read", "write", "delete"],
		});
		expect(report[0]?.limitations.join(" ")).toMatch(/events.*presigned/u);
		expect(() =>
			withCloudflareR2(neutralApplication, { missing: grant }),
		).toThrow("unknown resource");
		expect(() => withCloudflareR2(neutralApplication, { web: grant })).toThrow(
			"unannotated bucket",
		);
		expect(() =>
			withCloudflareR2(neutralApplication, {
				assets: { ...grant, grantEpoch: "invalid" },
			}),
		).toThrow("R2_GRANT_INVALID");
		let reads = 0;
		const accessor = Object.defineProperty({}, "assets", {
			enumerable: true,
			get() {
				reads++;
				return grant;
			},
		});
		expect(() => withCloudflareR2(neutralApplication, accessor)).toThrow(
			"unannotated bucket",
		);
		expect(reads).toBe(0);
		expect(() =>
			cloudflareR2BucketClaim("r2-app", "assets", JSON.parse("7")),
		).toThrow("R2_BUCKET_INVALID");
	});

	it("fails closed on absent bucket ownership, stale grant, or unsupported event/presign requirements", () => {
		const noGrant = {
			...application,
			resources: {
				...application.resources,
				assets: { ...application.resources.assets, declaredAllow: [] },
			},
		};
		expect(() =>
			mapBindleToAlchemy(noGrant, allowed(), { assessRequirements }),
		).toThrow("R2_GRANT_INVALID");
		expect(() =>
			mapBindleToAlchemy(application, allowed({ bucket: false }), {
				assessRequirements,
			}),
		).toThrow("R2_BUCKET_UNVERIFIED");
		expect(() =>
			mapBindleToAlchemy(application, allowed({ grant: false }), {
				assessRequirements,
			}),
		).toThrow("R2_GRANT_UNVERIFIED");
		for (const requirement of [
			"blob-events",
			"blob-presigned-urls",
			"wasi:blobstore",
		]) {
			const requested = {
				...application,
				requirements: {
					...application.requirements,
					require: [...application.requirements.require, requirement],
				},
			};
			expect(() =>
				mapBindleToAlchemy(requested, allowed(), { assessRequirements }),
			).toThrow("BINDLE_REQUIREMENTS_UNSUPPORTED");
		}
	});

	it("scopes bucket generations and nonreused grant epochs, including A→B→A", () => {
		const first = cloudflareR2ProxySource("r2-app", "assets", {
			...grant,
			allow: ["read"],
		});
		const second = cloudflareR2ProxySource("r2-app", "assets", {
			...grant,
			grantEpoch: `sha256:${"3".repeat(64)}`,
			allow: ["write"],
		});
		const third = cloudflareR2ProxySource("r2-app", "assets", {
			...grant,
			grantEpoch: `sha256:${"4".repeat(64)}`,
			allow: ["read"],
		});
		expect(
			new Set([first.resourceId, second.resourceId, third.resourceId]).size,
		).toBe(3);
		expect(
			cloudflareR2BucketClaim("other", "assets", grant.bucketEpoch).resourceId,
		).not.toBe(bucketClaim.resourceId);
		expect(
			cloudflareR2BucketClaim("r2-app", "assets", `sha256:${"5".repeat(64)}`)
				.resourceId,
		).not.toBe(bucketClaim.resourceId);
		expect(bucketClaim.legacyResourceId).toBe("assets");
	});

	it("binds the application module to the exact bucket and grant epochs", () => {
		const original = inspectCloudflareWorker(worker)?.bindings;
		expect(original).toEqual(
			cloudflareDependencyBindings({ assets: application.resources.assets }),
		);
		const nextGrant = withCloudflareR2(neutralApplication, {
			assets: { ...grant, grantEpoch: `sha256:${"3".repeat(64)}` },
		});
		const nextBucket = withCloudflareR2(neutralApplication, {
			assets: { ...grant, bucketEpoch: `sha256:${"4".repeat(64)}` },
		});
		expect(
			cloudflareDependencyBindings({ assets: nextGrant.resources.assets }),
		).not.toEqual(original);
		expect(
			cloudflareDependencyBindings({ assets: nextBucket.resources.assets }),
		).not.toEqual(original);
	});

	it("captures one immutable source-fence authority for both proxy and application", () => {
		let reads = 0;
		const mappers = cloudflareNativeR2BindleMappers({
			workerModules: { web: main },
			get sourceFence() {
				reads++;
				return sourceFence;
			},
			verifyBucket: (claim) =>
				JSON.stringify(claim) === JSON.stringify(bucketClaim),
			verifyGrant: (claim) =>
				claim.proxyResourceId === proxySource.resourceId &&
				claim.grantEpoch === grant.grantEpoch,
		});
		mapBindleToAlchemy(application, mappers, { assessRequirements });
		expect(reads).toBe(1);
	});

	it("isolates same-named buckets and composes KV in one real Alchemy stack", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cf-r2-"));
		const before = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			let deleted = 0;
			const created: {
				type: string;
				fqn: string;
				news: object;
				bindings?: object[];
			}[] = [];
			const bucketProvider = Provider.succeed(Bucket, {
				reconcile: ({ news, fqn }) =>
					Effect.sync(() => {
						created.push({ type: Bucket.Type, fqn, news });
						// SAFETY: this in-memory provider resolves the native bucket name and jurisdiction used by Worker bindings.
						return {
							...news,
							bucketName: fqn,
							jurisdiction: "default",
							storageClass: "Standard",
							accountId: "account",
							domains: [],
							lifecycleRules: [],
							cors: [],
							location: undefined,
							locks: undefined,
							localUploads: undefined,
							publicDomain: undefined,
						} as Bucket["Attributes"];
					}),
				delete: () =>
					Effect.sync(() => {
						deleted++;
					}),
			});
			const kvProvider = Provider.succeed(Namespace, {
				reconcile: ({ news, fqn }) =>
					Effect.sync(() => {
						created.push({ type: Namespace.Type, fqn, news });
						return {
							...news,
							title: news.title ?? "cache",
							namespaceId: fqn,
							accountId: "account",
							supportsUrlEncoding: undefined,
						};
					}),
				delete: () =>
					Effect.sync(() => {
						deleted++;
					}),
			});
			/* oxlint-disable anti-slop/no-chained-type-assertions -- SAFETY: beta.87 Worker is overloaded, and this test provider resolves only the binding attributes. */
			const workerProvider = Provider.succeed(
				Worker as unknown as ResourceClass<Worker>,
				{
					reconcile: ({ news, bindings, fqn }) =>
						Effect.sync(() => {
							created.push({ type: Worker.Type, fqn, news, bindings });
							// SAFETY: this fake resolves only the workerName consumed by the service binding.
							return {
								...news,
								workerName: fqn,
							} as unknown as Worker["Attributes"];
						}),
					delete: () =>
						Effect.sync(() => {
							deleted++;
						}),
				},
			);
			/* oxlint-enable anti-slop/no-chained-type-assertions */
			const providers = Layer.effect(
				Providers,
				Provider.collection([Bucket, Namespace, Worker]),
			).pipe(
				Layer.provide(
					Layer.mergeAll(bucketProvider, kvProvider, workerProvider),
				),
			);
			let authorized = true;
			const otherBucket = cloudflareR2BucketClaim(
				"r2-app-two",
				"assets",
				grant.bucketEpoch,
			);
			const otherProxy = cloudflareR2ProxySource("r2-app-two", "assets", {
				...grant,
				allow: ["read"],
			});
			const kvGrant = {
				mode: "read-only" as const,
				grantEpoch: `sha256:${"6".repeat(64)}`,
				namespaceEpoch: `sha256:${"7".repeat(64)}`,
			};
			const namespace = cloudflareKvNamespaceClaim(
				"r2-app-two",
				"cache",
				kvGrant.namespaceEpoch,
			);
			const kvProxy = cloudflareKvProxySource("r2-app-two", "cache", {
				...kvGrant,
				allow: ["get"],
			});
			const allSources = [proxySource, otherProxy, kvProxy, appSource];
			const scopedFence = {
				...sourceFence,
				verify: (claim: typeof proxySource) =>
					allSources.some(
						(source) =>
							source.resourceId === claim.resourceId &&
							source.bindleName === claim.bindleName &&
							source.applicationName === claim.applicationName &&
							source.sourceKind === claim.sourceKind &&
							source.sourcePath === claim.sourcePath &&
							source.resourceType === claim.resourceType,
					),
			};
			const mappers = cloudflareNativeR2BindleMappers({
				workerModules: { web: main },
				sourceFence: scopedFence,
				verifyBucket: (claim) =>
					authorized &&
					[bucketClaim, otherBucket].some(
						(expected) => JSON.stringify(claim) === JSON.stringify(expected),
					),
				verifyGrant: (claim) =>
					authorized &&
					[proxySource.resourceId, otherProxy.resourceId].includes(
						claim.proxyResourceId,
					) &&
					claim.grantEpoch === grant.grantEpoch,
				kv: {
					verifyNamespace: (claim) =>
						authorized && JSON.stringify(claim) === JSON.stringify(namespace),
					verifyGrant: (claim) =>
						authorized &&
						claim.proxyResourceId === kvProxy.resourceId &&
						claim.grantEpoch === kvGrant.grantEpoch,
				},
			});
			const mapped = mapBindleToAlchemy(application, mappers, {
				assessRequirements,
			});
			const other = withCloudflareEventualKv(
				{
					...application,
					name: "r2-app-two",
					resources: {
						assets: application.resources.assets,
						cache: {
							kind: "kv",
							name: "cache",
							stableId: "kv:cache",
							declaredAllow: ["get"],
							dependsOn: [],
							annotations: [],
						},
					},
					edges: [],
					entrypoint: () => undefined,
				},
				{ cache: kvGrant },
			);
			const otherMapped = mapBindleToAlchemy(other, mappers, {
				assessRequirements,
			});
			const states: NonNullable<Parameters<typeof inMemoryState>[0]> = {};
			const stack = Stack(
				"App",
				{ providers, state: inMemoryState(states) },
				Effect.gen(function* () {
					yield* mapped;
					yield* otherMapped;
					return {};
				}),
			);
			const target = alchemyTarget({
				targetId: "yard",
				tenantId: "tenant",
				stackName: "App",
				stage: "test",
				programResourceId: "app",
				sourceDigest: `sha256:${"a".repeat(64)}`,
				inventoryEvidenceRef: "inventory:1",
				resources: [
					{
						resourceId: namespace.resourceId,
						resourceType: "Cloudflare.KV.Namespace",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "kv",
					},
					{
						resourceId: kvProxy.resourceId,
						resourceType: "Cloudflare.Worker",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "worker",
					},
					{
						resourceId: otherBucket.resourceId,
						resourceType: "Cloudflare.R2.Bucket",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "r2",
					},
					{
						resourceId: otherProxy.resourceId,
						resourceType: "Cloudflare.Worker",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "worker",
					},
					{
						resourceId: bucketClaim.resourceId,
						resourceType: "Cloudflare.R2.Bucket",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "r2",
					},
					{
						resourceId: proxySource.resourceId,
						resourceType: "Cloudflare.Worker",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "worker",
					},
					{
						resourceId: "web",
						resourceType: "Cloudflare.Worker",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "worker",
					},
				],
			});
			let historicalAuthorized = false;
			const trustedPriorDigests = new Map<string, string>();
			const provider = createAlchemyIacProvider({
				stack,
				target,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: join(directory, "runtime"),
				route: routeFixture({ inventoryHash: `sha256:${"d".repeat(64)}` }).port,
				resolveRoute: ({ requestId }) => ({
					requestId: requestId ?? "request",
					operation: testOperation,
				}),
				composite: {
					proofRef: "test:host",
					environmentDigest: `sha256:${"b".repeat(64)}`,
					sourceRequirements: allSources,
					verifyEnvironment: () => true,
					verifyPlan: ({
						sourceClaims,
						historicalSources,
						historicalResources,
						operation,
						scope,
					}) => {
						if (sourceClaims.length !== 4) return false;
						if (operation !== "destroy") return true;
						return (
							historicalAuthorized &&
							[proxySource.resourceId, otherProxy.resourceId].every((id) =>
								historicalSources.some(
									(source) =>
										source.resourceId === id &&
										source.priorStateDigest === trustedPriorDigests.get(id),
								),
							) &&
							[bucketClaim.resourceId, otherBucket.resourceId].every(
								(id) =>
									historicalResources.some(
										(prior) =>
											prior.resourceId === id &&
											prior.resourceType === "Cloudflare.R2.Bucket" &&
											prior.priorResourceType === "Cloudflare.R2.Bucket" &&
											prior.action === "delete" &&
											prior.renamedFrom.length === 0 &&
											prior.priorStateDigest === trustedPriorDigests.get(id),
									) &&
									scope.some(
										(entry) =>
											entry.resourceId === id &&
											entry.resourceType === "Cloudflare.R2.Bucket" &&
											entry.providerAccountRef === "account",
									),
							)
						);
					},
				},
				financial: {
					assess: (plan) => ({ plan }),
					admit: async (requestId) => ({
						requestId,
						targetId: "yard",
						status: "admitted",
						code: "",
						message: "",
						budget: { evaluation: "allowed", reservation: "held" },
						reservation: { reservationId: `iac:${requestId}` },
						requestDigest: `sha256:${"c".repeat(64)}`,
						inventoryHash: `sha256:${"d".repeat(64)}`,
						modelHash: `sha256:${"e".repeat(64)}`,
						quoteHash: `sha256:${"f".repeat(64)}`,
					}),
					revalidate: () => true,
					uncertain: () => {},
				},
			});
			const program = {
				programId: "p",
				deploymentId: "d",
				resourceId: "app",
				provider: "cloudflare",
				driver: "external",
				action: "apply" as const,
				stackName: "App",
				operationGeneration: "generation-1",
			};
			expect((await provider.preview(program)).changes).toBe(7);
			authorized = false;
			await expect(
				provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ requiresReconciliation: false });
			expect(created).toEqual([]);
			authorized = true;
			await provider.preview(program);
			await provider.applyWithAdmission(program, "request-2");
			expect(
				created.filter((entry) => entry.type === Bucket.Type),
			).toHaveLength(2);
			expect(
				created.filter((entry) => entry.type === Namespace.Type),
			).toHaveLength(1);
			expect(
				new Set(
					created
						.filter((entry) => entry.type === Bucket.Type)
						.map((entry) => entry.fqn),
				),
			).toEqual(new Set([bucketClaim.resourceId, otherBucket.resourceId]));
			const proxy = created.find(
				(entry) => entry.fqn === proxySource.resourceId,
			);
			expect(proxy?.news).toMatchObject({
				workersDev: false,
				domain: null,
				routes: [],
				env: { HOBO_R2_ALLOW: "read" },
			});
			expect(proxy?.bindings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						data: expect.objectContaining({
							bindings: [
								expect.objectContaining({
									type: "r2_bucket",
									name: "HOBO_R2_BUCKET",
								}),
							],
						}),
					}),
				]),
			);
			const app = created.find(
				(entry) => entry.type === Worker.Type && entry.fqn === "web",
			);
			expect(app?.news).toMatchObject({
				env: {
					HOBO_RESOURCE_0: expect.objectContaining({
						workerName: proxySource.resourceId,
					}),
				},
			});
			const bytes = new TextEncoder().encode("hello");
			const result = await worker.fetch(new Request("https://app.test"), {
				HOBO_RESOURCE_0: {
					fetch: async (request: Request) =>
						new Response(bytes, {
							headers: {
								"x-hobo-r2-key": request.headers.get("x-hobo-r2-key") ?? "",
								"x-hobo-r2-content-type": "text%2Fplain",
								"x-hobo-r2-size": "5",
								"x-hobo-r2-digest": `sha256:${"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}`,
							},
						}),
				},
			});
			expect(await result.text()).toBe("hello");
			for (const id of [
				proxySource.resourceId,
				otherProxy.resourceId,
				bucketClaim.resourceId,
				otherBucket.resourceId,
			]) {
				const previous = states.App?.test?.[id];
				expect(previous).toBeDefined();
				trustedPriorDigests.set(id, hashAlchemyPriorState(previous));
			}
			const destroy = {
				...program,
				action: "destroy" as const,
				operationGeneration: "generation-2",
			};
			await expect(provider.preview(destroy)).rejects.toThrow(
				"COMPOSITE_PLAN_UNVERIFIED",
			);
			expect(deleted).toBe(0);
			historicalAuthorized = true;
			const savedBucketDigest = trustedPriorDigests.get(bucketClaim.resourceId);
			trustedPriorDigests.set(
				bucketClaim.resourceId,
				`sha256:${"0".repeat(64)}`,
			);
			await expect(provider.preview(destroy)).rejects.toThrow(
				"COMPOSITE_PLAN_UNVERIFIED",
			);
			expect(deleted).toBe(0);
			if (savedBucketDigest === undefined)
				throw new Error("trusted Bucket record is missing");
			trustedPriorDigests.set(bucketClaim.resourceId, savedBucketDigest);
			expect((await provider.preview(destroy)).changes).toBe(7);
			await provider.destroyWithAdmission(destroy, "destroy-request");
			expect(deleted).toBe(7);
		} finally {
			if (before === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = before;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
