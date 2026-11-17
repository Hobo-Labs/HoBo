import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Namespace } from "@alchemy.run/cloudflare/KV/Namespace";
import { Providers } from "@alchemy.run/cloudflare/Providers";
import { Queue } from "@alchemy.run/cloudflare/Queues/Queue";
import { Bucket } from "@alchemy.run/cloudflare/R2/Bucket";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	describeAlchemyPrimitiveSupport,
	mapBindleToAlchemy,
} from "../src/bindle.js";
import {
	cloudflareBindleMappers,
	cloudflareViteApp,
} from "../src/cloudflare.js";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { application } from "./fixtures/cloudflare-app.js";
import worker from "./fixtures/cloudflare-worker.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

const main = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/cloudflare-worker.ts",
);
const service = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/cloudflare-service.ts",
);
const moduleWithoutWorker = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/cloudflare-app.ts",
);
// The integration harness stubs the trusted host fence; production hosts must enforce it.
const sourceFence = {
	sourceDigest: `sha256:${"a".repeat(64)}`,
	environmentDigest: `sha256:${"b".repeat(64)}`,
	proofRef: "test:isolated-runtime",
	verify: () => true,
};

describe("real Alchemy Cloudflare mappings", () => {
	it.each([
		"app",
		"dependency",
		"revoked",
	] as const)("refuses a %s change between source admission and plan reconstruction", async (changed) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cf-source-"));
		try {
			const root = join(directory, "site");
			mkdirSync(root);
			const entry = join(root, "index.html");
			const dependency = join(root, "dependency.js");
			writeFileSync(entry, "<script src=dependency.js></script>");
			writeFileSync(dependency, "export const version = 1;");
			const digest = () =>
				`sha256:${createHash("sha256").update(readFileSync(entry)).update(readFileSync(dependency)).digest("hex")}`;
			const expected = digest();
			let allowed = true;
			let checks = 0;
			let providerCalls = 0;
			const fence = {
				sourceDigest: expected,
				environmentDigest: sourceFence.environmentDigest,
				proofRef: sourceFence.proofRef,
				verify: (claim) => {
					checks++;
					return (
						allowed &&
						claim.sourceKind === "vite" &&
						claim.sourcePath === root &&
						claim.sourceDigest === digest()
					);
				},
			};
			const marker = cloudflareViteApp("site");
			const app = {
				name: "site",
				resources: {
					web: {
						kind: "web",
						name: "web",
						stableId: "web:web",
						declaredAllow: [],
						dependsOn: [],
						annotations: [
							{
								provider: "hobo",
								option: "webapp",
								config: { framework: "vite", root: "site" },
							},
							{
								provider: "hobo",
								option: "session-replay",
								config: { enabled: false },
							},
						],
					},
				},
				edges: [],
				requirements: {},
				entrypoint: () => marker,
			};
			const mapped = mapBindleToAlchemy(
				app,
				cloudflareBindleMappers({
					workerModules: {},
					projectRoot: directory,
					sourceFence: fence,
				}),
				{
					assessRequirements: () => ({ status: "supported" }),
				},
			);
			if (changed === "app") writeFileSync(entry, "changed");
			if (changed === "dependency")
				writeFileSync(dependency, "export const version = 2;");
			if (changed === "revoked") allowed = false;
			const stub = Provider.succeed(Worker, {
				reconcile: () =>
					Effect.sync(() => {
						providerCalls++;
						return { id: "unexpected" };
					}),
				delete: () => Effect.void,
			});
			const providers = Layer.effect(
				Providers,
				Provider.collection([Worker]),
			).pipe(Layer.provide(stub));
			await expect(
				Effect.runPromise(
					Effect.provide(mapped, providers).pipe(
						Effect.provideService(StackContext, {
							name: "Test",
							stage: "test",
							resources: {},
							bindings: {},
							actions: {},
						}),
					),
				),
			).rejects.toThrow("SOURCE_FENCE_UNVERIFIED");
			expect(checks).toBeGreaterThanOrEqual(2);
			expect(providerCalls).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		[undefined, "worker module could not be imported"],
		[moduleWithoutWorker, "worker module has no bindle worker default export"],
		[main, "worker module does not bind this entrypoint"],
	])("rejects an HTTP module that is missing or does not bind the declared app", async (path, reason) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cf-module-"));
		try {
			const app = {
				name: "other",
				resources: {
					web: {
						kind: "web",
						name: "web",
						stableId: "web:web",
						declaredAllow: [],
						dependsOn: [],
						annotations: [
							{
								provider: "hobo",
								option: "session-replay",
								config: { enabled: false },
							},
						],
					},
				},
				edges: [],
				requirements: {},
				entrypoint: () => () => () => new Response("other"),
			};
			const mapped = mapBindleToAlchemy(
				app,
				cloudflareBindleMappers({
					workerModules: { web: path ?? join(directory, "absent.ts") },
					sourceFence,
				}),
				{
					assessRequirements: () => ({ status: "supported" }),
				},
			);
			const stub = Provider.succeed(Worker, {
				reconcile: () => Effect.succeed({ id: "unexpected" }),
				delete: () => Effect.void,
			});
			const providers = Layer.effect(
				Providers,
				Provider.collection([Worker]),
			).pipe(Layer.provide(stub));
			await expect(
				Effect.runPromise(
					Effect.provide(mapped, providers).pipe(
						Effect.provideService(StackContext, {
							name: "Test",
							stage: "test",
							resources: {},
							bindings: {},
							actions: {},
						}),
					),
				),
			).rejects.toThrow(reason);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("fails closed when a Vite root or entrypoint is forged, escapes the tree, or has runtime dependencies", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cf-vite-"));
		const outside = mkdtempSync(join(tmpdir(), "hobo-cf-outside-"));
		try {
			mkdirSync(join(directory, "site"));
			symlinkSync(outside, join(directory, "escape"), "dir");
			const marker = cloudflareViteApp("site");
			const app = {
				name: "site",
				resources: {
					web: {
						kind: "web",
						name: "web",
						stableId: "web:web",
						declaredAllow: [],
						dependsOn: [],
						annotations: [
							{
								provider: "hobo",
								option: "webapp",
								config: { framework: "vite", root: "site" },
							},
							{
								provider: "hobo",
								option: "session-replay",
								config: { enabled: false },
							},
						],
					},
				},
				edges: [],
				requirements: {},
				entrypoint: (name: string) => (name === "web" ? marker : undefined),
			};
			const mappers = cloudflareBindleMappers({
				workerModules: {},
				projectRoot: directory,
				sourceFence,
			});
			const opts = {
				assessRequirements: () => ({ status: "supported" as const }),
			};
			expect(() =>
				mapBindleToAlchemy(
					app,
					cloudflareBindleMappers({
						workerModules: {},
						projectRoot: directory,
					}),
					opts,
				),
			).toThrow("SOURCE_FENCE_REQUIRED");
			expect(() =>
				mapBindleToAlchemy(
					app,
					cloudflareBindleMappers({
						workerModules: {},
						projectRoot: directory,
						sourceFence: { ...sourceFence, verify: () => false },
					}),
					opts,
				),
			).toThrow("SOURCE_FENCE_UNVERIFIED");
			expect(() => mapBindleToAlchemy(app, mappers, opts)).not.toThrow();
			expect(() =>
				mapBindleToAlchemy(
					{ ...app, entrypoint: () => () => () => new Response("forged") },
					mappers,
					opts,
				),
			).toThrow("provider-owned entrypoint");
			for (const root of ["../outside", "/etc", "escape", "missing"]) {
				const altered = {
					...app,
					resources: {
						web: {
							...app.resources.web,
							annotations: [
								{
									provider: "hobo",
									option: "webapp",
									config: { framework: "vite", root },
								},
							],
						},
					},
					entrypoint: () => cloudflareViteApp(root),
				};
				expect(() => mapBindleToAlchemy(altered, mappers, opts)).toThrow(
					"Vite",
				);
			}
			const withDependency = {
				...app,
				resources: {
					...app.resources,
					web: { ...app.resources.web, dependsOn: ["kv"] },
					cache: {
						kind: "kv",
						name: "cache",
						stableId: "kv:cache",
						declaredAllow: [],
						dependsOn: [],
						annotations: [],
					},
				},
				edges: [{ from: "web", to: "cache" }],
			};
			expect(() => mapBindleToAlchemy(withDependency, mappers, opts)).toThrow(
				"dependencies are not bound",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it.each([
		"stable",
		"revoked",
	] as const)("plans, deploys and destroys the native Vite component with a %s host fence", async (mode) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cf-vite-"));
		const before = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			mkdirSync(join(directory, "site"));
			const marker = cloudflareViteApp("site");
			const app = {
				name: "site",
				resources: {
					web: {
						kind: "web",
						name: "web",
						stableId: "web:web",
						declaredAllow: [],
						dependsOn: [],
						annotations: [
							{
								provider: "hobo",
								option: "webapp",
								config: { framework: "vite", root: "site" },
							},
							{
								provider: "hobo",
								option: "session-replay",
								config: { enabled: false },
							},
						],
					},
				},
				edges: [],
				requirements: {},
				entrypoint: () => marker,
			};
			const seen: object[] = [];
			let deleted = 0;
			let fenceActive = true;
			const activeFence = { ...sourceFence, verify: () => fenceActive };
			const uncertain: string[] = [];
			const historicalDigests: string[] = [];
			const workerProvider = Provider.succeed(Worker, {
				reconcile: ({ news }) =>
					Effect.sync(() => {
						seen.push(news);
						return { ...news, id: "web" };
					}),
				delete: () =>
					Effect.sync(() => {
						deleted++;
						if (mode === "revoked") fenceActive = false;
					}),
			});
			const providers = Layer.effect(
				Providers,
				Provider.collection([Worker]),
			).pipe(Layer.provide(workerProvider));
			const mapped = mapBindleToAlchemy(
				app,
				cloudflareBindleMappers({
					workerModules: {},
					projectRoot: directory,
					sourceFence: activeFence,
				}),
				{
					assessRequirements: () => ({ status: "supported" }),
				},
			);
			const stack = Stack(
				"App",
				{ providers, state: inMemoryState() },
				mapped.pipe(Effect.map(() => ({}))),
			);
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				route: routeFixture({ inventoryHash: `sha256:${"d".repeat(64)}` }).port,
				resolveRoute: async ({ requestId }) => ({
					requestId: requestId ?? "request",
					operation: testOperation,
				}),
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: join(directory, "runtime"),
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "App",
					stage: "test",
					programResourceId: "app",
					sourceDigest: `sha256:${"a".repeat(64)}`,
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "web",
							resourceType: "Cloudflare.Worker",
							providerId: "cloudflare",
							providerAccountRef: "account",
							productId: "worker",
						},
					],
				}),
				composite: {
					proofRef: "test:isolated-runtime",
					environmentDigest: `sha256:${"b".repeat(64)}`,
					sourceRequirements: [
						{
							resourceId: "web",
							resourceType: "Cloudflare.Worker",
							bindleName: "site",
							applicationName: "web",
							sourceKind: "vite",
							sourcePath: join(directory, "site"),
						},
					],
					verifyEnvironment: () => fenceActive,
					verifyPlan: ({ sourceClaims, historicalSources, operation }) => {
						expect(sourceClaims).toMatchObject([
							{
								resourceId: "web",
								resourceType: "Cloudflare.Worker",
								bindleName: "site",
								applicationName: "web",
								sourceKind: "vite",
								sourcePath: join(directory, "site"),
								sourceDigest: sourceFence.sourceDigest,
							},
						]);
						if (operation === "destroy") {
							expect(historicalSources).toMatchObject([
								{
									resourceId: "web",
									resourceType: "Cloudflare.Worker",
									priorStateDigest: expect.stringMatching(
										/^sha256:[a-f0-9]{64}$/u,
									),
								},
							]);
							historicalDigests.push(
								historicalSources[0]?.priorStateDigest ?? "",
							);
						}
						return fenceActive;
					},
				},
				financial: {
					assess: (inventory) => ({ inventory }),
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
					uncertain: (reservationId) => {
						uncertain.push(reservationId);
					},
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
			expect((await provider.preview(program)).changes).toBe(1);
			await provider.applyWithAdmission(program, "request");
			expect(seen).toMatchObject([
				{ vite: { rootDir: join(directory, "site") } },
			]);
			const destroy = {
				...program,
				action: "destroy" as const,
				operationGeneration: "generation-2",
			};
			expect((await provider.preview(destroy)).changes).toBe(1);
			if (mode === "revoked")
				await expect(
					provider.destroyWithAdmission(destroy, "destroy-request"),
				).rejects.toMatchObject({
					code: "SOURCE_FENCE_UNCERTAIN",
					requiresReconciliation: true,
					executionOutcome: "completed",
				});
			else await provider.destroyWithAdmission(destroy, "destroy-request");
			expect(deleted).toBe(1);
			expect(uncertain).toEqual(
				mode === "revoked" ? ["iac:destroy-request"] : [],
			);
			expect(new Set(historicalDigests).size).toBe(1);
		} finally {
			if (before === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = before;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("reports queue consumer and topic support accurately", () => {
		const support = describeAlchemyPrimitiveSupport(
			[
				{ factory: "bucket", allowVerbs: ["read", "write", "delete"] },
				{ factory: "kv", allowVerbs: ["get", "set", "delete"] },
				{ factory: "queue", allowVerbs: ["enqueue", "dequeue"] },
				{ factory: "topic", allowVerbs: ["publish", "subscribe"] },
				{ factory: "web", allowVerbs: [] },
			],
			cloudflareBindleMappers({ workerModules: { web: main } }),
		);
		expect(
			support.map(({ kind, status, unsupportedOperations }) => ({
				kind,
				status,
				unsupportedOperations,
			})),
		).toEqual([
			{
				kind: "bucket",
				status: "partial",
				unsupportedOperations: ["read", "write", "delete"],
			},
			{
				kind: "kv",
				status: "partial",
				unsupportedOperations: ["get", "set", "delete"],
			},
			{
				kind: "queue",
				status: "partial",
				unsupportedOperations: ["enqueue", "dequeue"],
			},
			{
				kind: "topic",
				status: "unsupported",
				unsupportedOperations: ["publish", "subscribe"],
			},
			{ kind: "web", status: "partial", unsupportedOperations: [] },
		]);
	});

	it("constructs real R2, KV, Queue and Workers, and invokes the exact bound app with a service binding", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cf-map-"));
		const before = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		const created: string[] = [];
		try {
			const stub = (resource) =>
				Provider.succeed(resource, {
					reconcile: ({ news }) =>
						Effect.sync(() => {
							created.push(resource.Type);
							return { id: resource.Type, ...news };
						}),
					delete: () => Effect.void,
				});
			const providers = Layer.effect(
				Providers,
				Provider.collection([Bucket, Namespace, Queue, Worker]),
			).pipe(
				Layer.provide(
					Layer.mergeAll(
						stub(Bucket),
						stub(Namespace),
						stub(Queue),
						stub(Worker),
					),
				),
			);
			const mapped = mapBindleToAlchemy(
				application,
				cloudflareBindleMappers({
					workerModules: { web: main, catalog: service },
					sourceFence,
				}),
				{
					assessRequirements: () => ({ status: "supported" }),
				},
			);
			const stack = Stack(
				"App",
				{ providers, state: inMemoryState() },
				mapped.pipe(Effect.map(() => ({}))),
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
						resourceId: "catalog",
						resourceType: "Cloudflare.Worker",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "worker",
					},
					{
						resourceId: "assets",
						resourceType: "Cloudflare.R2.Bucket",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "r2",
					},
					{
						resourceId: "cache",
						resourceType: "Cloudflare.KV.Namespace",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "kv",
					},
					{
						resourceId: "jobs",
						resourceType: "Cloudflare.Queues.Queue",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "queue",
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
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				route: routeFixture({ inventoryHash: `sha256:${"d".repeat(64)}` }).port,
				resolveRoute: async ({ requestId }) => ({
					requestId: requestId ?? "request",
					operation: testOperation,
				}),
				stack,
				target,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: join(directory, "runtime"),
				composite: {
					proofRef: "test:isolated-runtime",
					environmentDigest: `sha256:${"b".repeat(64)}`,
					sourceRequirements: [
						{
							resourceId: "catalog",
							resourceType: "Cloudflare.Worker",
							bindleName: "shop",
							applicationName: "catalog",
							sourceKind: "worker",
							sourcePath: service,
						},
						{
							resourceId: "web",
							resourceType: "Cloudflare.Worker",
							bindleName: "shop",
							applicationName: "web",
							sourceKind: "worker",
							sourcePath: main,
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) => {
						expect(sourceClaims).toMatchObject([
							{
								resourceId: "catalog",
								resourceType: "Cloudflare.Worker",
								bindleName: "shop",
								applicationName: "catalog",
								sourceKind: "worker",
								sourcePath: service,
								sourceDigest: sourceFence.sourceDigest,
							},
							{
								resourceId: "web",
								resourceType: "Cloudflare.Worker",
								bindleName: "shop",
								applicationName: "web",
								sourceKind: "worker",
								sourcePath: main,
								sourceDigest: sourceFence.sourceDigest,
							},
						]);
						return true;
					},
				},
				financial: {
					assess: (inventory) => ({ inventory }),
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
			expect((await provider.preview(program)).changes).toBe(5);
			await provider.applyWithAdmission(program, "request");
			expect(new Set(created)).toEqual(
				new Set([
					"Cloudflare.R2.Bucket",
					"Cloudflare.KV.Namespace",
					"Cloudflare.Queues.Queue",
					"Cloudflare.Worker",
				]),
			);
			const calls: string[] = [];
			const response = await worker.fetch(new Request("https://example.test"), {
				HOBO_RESOURCE_0: {
					async fetch(request: Request) {
						calls.push(new URL(request.url).pathname);
						return new Response("ran app logic");
					},
				},
			});
			expect(await response.text()).toBe("ran app logic");
			expect(calls).toEqual(["/item"]);
		} finally {
			if (before === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = before;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
