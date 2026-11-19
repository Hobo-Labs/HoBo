import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Namespace } from "@alchemy.run/cloudflare/KV/Namespace";
import { Providers } from "@alchemy.run/cloudflare/Providers";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import type { ResourceClass } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import { mapBindleToAlchemy } from "../src/bindle.js";
import {
	cloudflareKvNamespaceClaim,
	cloudflareKvProxySource,
	cloudflareNativeKvBindleMappers,
} from "../src/cloudflare-native-kv.js";
import { withCloudflareEventualKv } from "../src/cloudflare-runtime.js";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

it("keeps same-named KV resources in different Bindles isolated in one real Alchemy stack", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-kv-isolation-"));
	const before = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = join(directory, "home");
	try {
		const grant = {
			mode: "read-only" as const,
			grantEpoch: `sha256:${"1".repeat(64)}`,
			namespaceEpoch: `sha256:${"4".repeat(64)}`,
		};
		const names = ["first", "second"];
		const namespaceClaims = names.map((name) =>
			cloudflareKvNamespaceClaim(name, "cache", grant.namespaceEpoch),
		);
		const proxyClaims = names.map((name) =>
			cloudflareKvProxySource(name, "cache", { ...grant, allow: ["get"] }),
		);
		expect(new Set(namespaceClaims.map((claim) => claim.resourceId)).size).toBe(
			2,
		);
		const observed: { fqn: string; bindings: object[] }[] = [];
		const namespaceProvider = Provider.succeed(Namespace, {
			reconcile: ({ news, fqn }) =>
				Effect.succeed({
					...news,
					title: news.title ?? fqn,
					namespaceId: fqn,
					accountId: "account",
					supportsUrlEncoding: undefined,
				}),
			delete: () => Effect.void,
		});
		/* oxlint-disable anti-slop/no-chained-type-assertions -- SAFETY: the fake provider models only the beta.87 Worker fields exercised by this binding test. */
		const workerProvider = Provider.succeed(
			Worker as unknown as ResourceClass<Worker>,
			{
				reconcile: ({ news, bindings, fqn }) =>
					Effect.sync(() => {
						observed.push({ fqn, bindings });
						// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this provider double only exposes the workerName consumed by the binding.
						return {
							...news,
							workerName: fqn,
						} as unknown as Worker["Attributes"];
					}),
				delete: () => Effect.void,
			},
		);
		/* oxlint-enable anti-slop/no-chained-type-assertions */
		const providers = Layer.effect(
			Providers,
			Provider.collection([Namespace, Worker]),
		).pipe(Layer.provide(Layer.mergeAll(namespaceProvider, workerProvider)));
		const sourceFence = {
			sourceDigest: `sha256:${"a".repeat(64)}`,
			environmentDigest: `sha256:${"b".repeat(64)}`,
			proofRef: "test:host",
			verify: () => true,
		};
		const mappers = cloudflareNativeKvBindleMappers({
			workerModules: {},
			sourceFence,
			verifyNamespace: (claim) =>
				namespaceClaims.some(
					(expected) => JSON.stringify(expected) === JSON.stringify(claim),
				),
			verifyGrant: (claim) =>
				proxyClaims.some(
					(expected) => expected.resourceId === claim.proxyResourceId,
				),
		});
		const mapped = names.map((name) =>
			mapBindleToAlchemy(
				withCloudflareEventualKv(
					{
						name,
						resources: {
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
						requirements: {},
						entrypoint: () => undefined,
					},
					{ cache: grant },
				),
				mappers,
				{ assessRequirements: () => ({ status: "supported" }) },
			),
		);
		const stack = Stack(
			"App",
			{ providers, state: inMemoryState() },
			Effect.gen(function* () {
				for (const item of mapped) yield* item;
				return {};
			}),
		);
		const target = alchemyTarget({
			targetId: "yard",
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest: sourceFence.sourceDigest,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				...namespaceClaims.map(({ resourceId }) => ({
					resourceId,
					resourceType: Namespace.Type,
					providerId: "cloudflare",
					providerAccountRef: "account",
					productId: "kv",
				})),
				...proxyClaims.map(({ resourceId }) => ({
					resourceId,
					resourceType: Worker.Type,
					providerId: "cloudflare",
					providerAccountRef: "account",
					productId: "worker",
				})),
			],
		});
		const provider = createAlchemyIacProvider({
			stateOwnership: testStateOwnership,
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
				proofRef: sourceFence.proofRef,
				environmentDigest: sourceFence.environmentDigest,
				sourceRequirements: proxyClaims,
				verifyEnvironment: () => true,
				verifyPlan: () => true,
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
		expect((await provider.preview(program)).changes).toBe(4);
		await provider.applyWithAdmission(program, "request");
		for (let index = 0; index < names.length; index++) {
			const proxy = observed.find(
				(entry) => entry.fqn === proxyClaims[index]?.resourceId,
			);
			expect(proxy?.bindings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						data: expect.objectContaining({
							bindings: [
								expect.objectContaining({
									type: "kv_namespace",
									name: "HOBO_KV_NAMESPACE",
									namespaceId: namespaceClaims[index]?.resourceId,
								}),
							],
						}),
					}),
				]),
			);
		}
	} finally {
		if (before === undefined) delete process.env.ALCHEMY_HOME;
		else process.env.ALCHEMY_HOME = before;
		rmSync(directory, { recursive: true, force: true });
	}
});
