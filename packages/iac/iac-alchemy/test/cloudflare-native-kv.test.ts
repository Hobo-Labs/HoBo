import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Namespace } from "@alchemy.run/cloudflare/KV/Namespace";
import { Providers } from "@alchemy.run/cloudflare/Providers";
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
	type CloudflareKvProxyEnvironment,
	cloudflareKvProxy,
} from "../src/cloudflare-kv-proxy.js";
import {
	cloudflareKvProxySource,
	cloudflareNativeKvBindleMappers,
} from "../src/cloudflare-native-kv.js";
import {
	bindleCloudflareWorker,
	CLOUDFLARE_KV_MAX_VALUE_BYTES,
	type CloudflareBindleContext,
	cloudflareBindings,
	cloudflareEventualKv,
	withCloudflareEventualKv,
} from "../src/cloudflare-runtime.js";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import worker, {
	application,
	neutralApplication,
} from "./fixtures/cloudflare-kv-app.js";
import { routeFixture, testOperation } from "./route-fixture.js";

const main = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/cloudflare-kv-app.ts",
);
const httpAnnotation = {
	provider: "hobo",
	option: "session-replay",
	config: { enabled: false },
};

function appFor(
	mode: "read-only" | "write-only",
	allow: string[],
	entrypoint: (context?: CloudflareBindleContext) => () => Promise<Response>,
) {
	return {
		name: "app",
		resources: {
			cache: {
				kind: "kv",
				name: "cache",
				stableId: "kv:cache",
				declaredAllow: allow,
				dependsOn: [],
				annotations: [cloudflareEventualKv(mode)],
			},
			web: {
				kind: "web",
				name: "web",
				stableId: "web:web",
				declaredAllow: [],
				dependsOn: ["kv"],
				annotations: [httpAnnotation],
			},
		},
		edges: [{ from: "web", to: "cache" }],
		requirements: {},
		entrypoint: (name: string) => (name === "web" ? entrypoint : undefined),
	};
}

function nativeNamespace() {
	const values = new Map<string, Uint8Array>();
	const calls: string[] = [];
	return {
		values,
		calls,
		binding: {
			async get(key: string, type: "arrayBuffer") {
				calls.push(`get:${key}:${type}`);
				const value = values.get(key);
				return value === undefined ? null : new Uint8Array(value).buffer;
			},
			async put(key: string, value: ArrayBuffer) {
				calls.push(`put:${key}`);
				values.set(key, new Uint8Array(value.slice(0)));
			},
			async delete(key: string) {
				calls.push(`delete:${key}`);
				values.delete(key);
			},
		},
	};
}

function service(environment: CloudflareKvProxyEnvironment) {
	return {
		fetch: (request: Request) => cloudflareKvProxy.fetch(request, environment),
	};
}

function assessRequirements(requirements: {
	readonly require: readonly string[];
	readonly runtimes: readonly string[];
}) {
	return JSON.stringify(requirements.require) ===
		JSON.stringify(["http", "kv-eventual-read"]) &&
		JSON.stringify(requirements.runtimes) === JSON.stringify(["javascript"])
		? { status: "supported" as const }
		: {
				status: "unsupported" as const,
				reason: "only the declared JavaScript subset is available",
			};
}

describe("Cloudflare eventual KV JavaScript subset", () => {
	it("keeps the real Bindle provider-neutral and rejects invalid target choices", () => {
		expect(neutralApplication.resources.cache?.annotations).toEqual([]);
		expect(neutralApplication.requirements).toMatchObject({
			require: ["http", "kv-eventual-read"],
			runtimes: ["javascript"],
		});
		expect(
			assessRequirements({
				require: ["http", "kv"],
				runtimes: ["wasm"],
			}).status,
		).toBe("unsupported");
		expect(application.resources.cache?.annotations).toMatchObject([
			{ provider: "cloudflare", option: "eventual-kv" },
		]);
		expect(() =>
			withCloudflareEventualKv(neutralApplication, { missing: "read-only" }),
		).toThrow("unknown resource");
		expect(() =>
			withCloudflareEventualKv(neutralApplication, { web: "read-only" }),
		).toThrow("unannotated KV resource");
		const accessor = Object.defineProperty({}, "cache", {
			enumerable: true,
			get() {
				throw new Error("must not invoke accessors");
			},
		});
		expect(() =>
			withCloudflareEventualKv(neutralApplication, accessor),
		).toThrow("unannotated KV resource");
	});

	it("requires independent authorization of the proxy source before mapping", () => {
		for (const sourceFence of [
			undefined,
			{
				sourceDigest: `sha256:${"a".repeat(64)}`,
				environmentDigest: `sha256:${"b".repeat(64)}`,
				proofRef: "test:host",
				verify: () => false,
			},
		]) {
			const mappingOptions =
				sourceFence === undefined
					? { workerModules: { web: main } }
					: { workerModules: { web: main }, sourceFence };
			expect(() =>
				mapBindleToAlchemy(
					application,
					cloudflareNativeKvBindleMappers(mappingOptions),
					{ assessRequirements: () => ({ status: "supported" }) },
				),
			).toThrow(/SOURCE_FENCE_(REQUIRED|UNVERIFIED)/u);
		}
	});
	it("reads binary, empty and missing values through an isolated read-only proxy", async () => {
		const native = nativeNamespace();
		native.values.set("bin\u0000雪", new Uint8Array([0, 255, 127]));
		native.values.set("empty", new Uint8Array());
		const app = appFor("read-only", ["get"], (context) => async () => {
			const kv = cloudflareBindings(context).kv("cache");
			expect(await kv.get("bin\u0000雪")).toEqual(
				new Uint8Array([0, 255, 127]),
			);
			expect(await kv.get("empty")).toEqual(new Uint8Array());
			expect(await kv.exists("empty")).toBe(true);
			expect(await kv.get("missing")).toBeUndefined();
			expect(await kv.exists("missing")).toBe(false);
			await expect(
				kv.set({ key: "no", value: new Uint8Array([1]) }),
			).rejects.toMatchObject({ code: "KV_OPERATION_DENIED" });
			return new Response("ok");
		});
		const handler = bindleCloudflareWorker(app, "web");
		const result = await handler.fetch(new Request("https://app.test"), {
			HOBO_RESOURCE_0: service({
				HOBO_KV_MODE: "read-only",
				HOBO_KV_ALLOW: "get",
				HOBO_KV_NAMESPACE: native.binding,
			}),
		});
		expect(await result.text()).toBe("ok");
		expect(native.calls.every((call) => call.startsWith("get:"))).toBe(true);
	});

	it("enforces every write verb in the isolated proxy even if the app bypasses its wrapper", async () => {
		const native = nativeNamespace();
		const environment = {
			HOBO_KV_MODE: "write-only" as const,
			HOBO_KV_ALLOW: "set" as const,
			HOBO_KV_NAMESPACE: native.binding,
		};
		const request = (path: string) =>
			new Request(`https://hobo-kv.internal/${path}`, {
				method: "POST",
				headers: { "x-hobo-kv-key": "key" },
				body: new Uint8Array([1]),
			});
		expect(
			(await cloudflareKvProxy.fetch(request("get"), environment)).status,
		).toBe(403);
		expect(
			(await cloudflareKvProxy.fetch(request("delete"), environment)).status,
		).toBe(403);
		expect(
			(await cloudflareKvProxy.fetch(request("set"), environment)).status,
		).toBe(204);
		expect(native.calls).toEqual(["put:key"]);
	});

	it("allows an explicitly granted delete without granting writes or reads", async () => {
		const native = nativeNamespace();
		const app = appFor("write-only", ["delete"], (context) => async () => {
			const kv = cloudflareBindings(context).kv("cache");
			await kv.delete("key");
			await expect(kv.get("key")).rejects.toMatchObject({
				code: "KV_OPERATION_DENIED",
			});
			await expect(
				kv.set({ key: "key", value: new Uint8Array() }),
			).rejects.toMatchObject({
				code: "KV_OPERATION_DENIED",
			});
			return new Response("ok");
		});
		await bindleCloudflareWorker(app, "web").fetch(
			new Request("https://app.test"),
			{
				HOBO_RESOURCE_0: service({
					HOBO_KV_MODE: "write-only",
					HOBO_KV_ALLOW: "delete",
					HOBO_KV_NAMESPACE: native.binding,
				}),
			},
		);
		expect(native.calls).toEqual(["delete:key"]);
	});

	it("reports an unknown mutation outcome and never retries a failed native write", async () => {
		const native = nativeNamespace();
		const app = appFor("write-only", ["set"], (context) => async () => {
			await expect(
				cloudflareBindings(context)
					.kv("cache")
					.set({ key: "key", value: new Uint8Array([7]) }),
			).rejects.toMatchObject({ code: "KV_MUTATION_OUTCOME_UNKNOWN" });
			return new Response("ok");
		});
		const handler = bindleCloudflareWorker(app, "web");
		const environment = {
			HOBO_KV_MODE: "write-only" as const,
			HOBO_KV_ALLOW: "set" as const,
			HOBO_KV_NAMESPACE: {
				...native.binding,
				async put(key: string, value: ArrayBuffer) {
					await native.binding.put(key, value);
					throw new Error("lost acknowledgment");
				},
			},
		};
		await handler.fetch(new Request("https://app.test"), {
			HOBO_RESOURCE_0: service(environment),
		});
		expect(native.calls).toEqual(["put:key"]);
		expect(native.values.get("key")).toEqual(new Uint8Array([7]));
	});

	it("reports backend read failures and does not return fabricated absence", async () => {
		const native = nativeNamespace();
		const app = appFor("read-only", ["get"], (context) => async () => {
			await expect(
				cloudflareBindings(context).kv("cache").get("key"),
			).rejects.toMatchObject({ code: "KV_READ_UNAVAILABLE" });
			return new Response("ok");
		});
		await bindleCloudflareWorker(app, "web").fetch(
			new Request("https://app.test"),
			{
				HOBO_RESOURCE_0: service({
					HOBO_KV_MODE: "read-only",
					HOBO_KV_ALLOW: "get",
					HOBO_KV_NAMESPACE: {
						...native.binding,
						async get() {
							throw new Error("native read unavailable");
						},
					},
				}),
			},
		);
	});

	it.each([
		["read-only", []],
		["read-only", ["get", "set"]],
		["write-only", ["get"]],
		["write-only", ["set", "get"]],
	] as const)("rejects incompatible %s grants %j before binding", (mode, allow) => {
		const app = appFor(
			mode,
			[...allow],
			() => async () => new Response("unused"),
		);
		expect(() => bindleCloudflareWorker(app, "web")).toThrow("allow list");
	});

	it("rejects invalid keys and oversized values before touching the namespace", async () => {
		const native = nativeNamespace();
		const app = appFor("write-only", ["set"], (context) => async () => {
			const kv = cloudflareBindings(context).kv("cache");
			for (const key of ["", ".", "..", "a".repeat(513), "\ud800"])
				await expect(
					kv.set({ key, value: new Uint8Array() }),
				).rejects.toMatchObject({ code: "KV_KEY_INVALID" });
			await expect(
				kv.set({
					key: "ok",
					value: new Uint8Array(CLOUDFLARE_KV_MAX_VALUE_BYTES + 1),
				}),
			).rejects.toMatchObject({ code: "KV_VALUE_INVALID" });
			return new Response("ok");
		});
		await bindleCloudflareWorker(app, "web").fetch(
			new Request("https://app.test"),
			{
				HOBO_RESOURCE_0: service({
					HOBO_KV_MODE: "write-only",
					HOBO_KV_ALLOW: "set",
					HOBO_KV_NAMESPACE: native.binding,
				}),
			},
		);
		expect(native.calls).toEqual([]);
	});

	it("maps and applies real Alchemy Namespace and private proxy Worker resources", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cf-kv-"));
		const before = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const created: { type: string; news: object; bindings?: object[] }[] = [];
			const uncertain: string[] = [];
			let admissions = 0;
			let revokeOnFinancialRevalidation = false;
			const proxySource = cloudflareKvProxySource("kv-app", "cache");
			const appSource = {
				resourceId: "web",
				resourceType: "Cloudflare.Worker",
				bindleName: "kv-app",
				applicationName: "web",
				sourceKind: "worker",
				sourcePath: main,
			};
			const sourceRequirements = [proxySource, appSource];
			const proxyContentDigest = () =>
				createHash("sha256")
					.update(readFileSync(proxySource.sourcePath))
					.update(
						readFileSync(
							join(
								dirname(proxySource.sourcePath),
								"cloudflare-kv-protocol.ts",
							),
						),
					)
					.digest("hex");
			const approvedProxyDigest = proxyContentDigest();
			let presentedProxyDigest = approvedProxyDigest;
			let proxyAuthorized = true;
			const sourceFence = {
				sourceDigest: `sha256:${"a".repeat(64)}`,
				environmentDigest: `sha256:${"b".repeat(64)}`,
				proofRef: "test:host",
				verify: (claim: typeof proxySource) =>
					proxyAuthorized &&
					presentedProxyDigest === approvedProxyDigest &&
					proxyContentDigest() === approvedProxyDigest &&
					sourceRequirements.some(
						(requirement) =>
							requirement.resourceId === claim.resourceId &&
							requirement.resourceType === claim.resourceType &&
							requirement.bindleName === claim.bindleName &&
							requirement.applicationName === claim.applicationName &&
							requirement.sourceKind === claim.sourceKind &&
							requirement.sourcePath === claim.sourcePath,
					),
			};
			const namespaceProvider = Provider.succeed(Namespace, {
				reconcile: ({ news }) =>
					Effect.sync(() => {
						created.push({ type: Namespace.Type, news });
						return {
							...news,
							title: news.title ?? "cache",
							namespaceId: "ns",
							accountId: "account",
							supportsUrlEncoding: undefined,
						};
					}),
				delete: () => Effect.void,
			});
			// SAFETY: beta.87's overloaded Worker constructor is the real class;
			// its generic overload is narrower than Provider.succeed's test port.
			/* oxlint-disable anti-slop/no-chained-type-assertions -- SAFETY: this provider is a narrowly scoped test double for beta.87's overloaded Worker class. */
			const workerProvider = Provider.succeed(
				Worker as unknown as ResourceClass<Worker>,
				{
					reconcile: ({ news, bindings, fqn }) =>
						Effect.sync(() => {
							created.push({ type: Worker.Type, news, bindings });
							// SAFETY: this in-memory test provider only resolves the workerName
							// consumed by the real service-binding implementation.
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
			const mappers = cloudflareNativeKvBindleMappers({
				workerModules: { web: main },
				sourceFence,
			});
			const coverage = describeAlchemyPrimitiveSupport(
				[{ factory: "kv", allowVerbs: ["get", "set", "delete"] }],
				mappers,
			);
			expect(coverage[0]).toMatchObject({
				status: "partial",
				supportedOperations: ["get", "set", "delete"],
			});
			const mapped = mapBindleToAlchemy(application, mappers, {
				assessRequirements,
			});
			const stack = Stack(
				"App",
				{ providers, state: inMemoryState() },
				mapped.pipe(Effect.map(() => ({}))),
			);
			const proxyId = proxySource.resourceId;
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
						resourceId: "cache",
						resourceType: "Cloudflare.KV.Namespace",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "kv",
					},
					{
						resourceId: proxyId,
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
			const makeProvider = (
				currentTarget = target,
				currentSources = sourceRequirements,
			) =>
				createAlchemyIacProvider({
					stack,
					target: currentTarget,
					runtimeLayer: Alchemist.layer(),
					runtimeDirectory: join(directory, "runtime"),
					route: routeFixture({ inventoryHash: `sha256:${"d".repeat(64)}` })
						.port,
					resolveRoute: ({ requestId }) => ({
						requestId: requestId ?? "request",
						operation: testOperation,
					}),
					composite: {
						proofRef: "test:host",
						environmentDigest: `sha256:${"b".repeat(64)}`,
						sourceRequirements: currentSources,
						verifyEnvironment: () => true,
						verifyPlan: ({ sourceClaims }) => {
							expect(sourceClaims).toHaveLength(2);
							expect(sourceClaims).toEqual(
								expect.arrayContaining([
									expect.objectContaining(proxySource),
									expect.objectContaining(appSource),
								]),
							);
							return true;
						},
					},
					financial: {
						assess: (plan) => ({ plan }),
						admit: async (requestId) => {
							admissions++;
							return {
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
							};
						},
						revalidate: () => {
							if (revokeOnFinancialRevalidation) proxyAuthorized = false;
							return true;
						},
						uncertain: (id) => {
							uncertain.push(id);
						},
					},
				});
			const provider = makeProvider();
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
			expect((await provider.preview(program)).changes).toBe(3);
			await expect(
				makeProvider(target, [appSource]).preview(program),
			).rejects.toThrow("SOURCE_FENCE_INCOMPLETE");
			await expect(
				makeProvider(target, [
					{ ...proxySource, sourcePath: `${proxySource.sourcePath}.changed` },
					appSource,
				]).preview(program),
			).rejects.toThrow("SOURCE_FENCE_INCOMPLETE");
			const incompleteTarget = alchemyTarget({
				...target,
				resources: target.resources.filter(
					(entry) => entry.resourceId !== proxyId,
				),
			});
			await expect(
				makeProvider(incompleteTarget).preview(program),
			).rejects.toThrow("TARGET_INVENTORY_INCOMPLETE");
			await expect(
				makeProvider(incompleteTarget).applyWithAdmission(program, "missing"),
			).rejects.toThrow("PREVIEW_REQUIRED");
			expect(admissions).toBe(0);
			proxyAuthorized = false;
			await expect(provider.preview(program)).rejects.toThrow(
				"SOURCE_FENCE_UNVERIFIED",
			);
			expect(created).toEqual([]);
			proxyAuthorized = true;
			presentedProxyDigest = "changed";
			await expect(provider.preview(program)).rejects.toThrow(
				"SOURCE_FENCE_UNVERIFIED",
			);
			expect(created).toEqual([]);
			presentedProxyDigest = approvedProxyDigest;
			const revokedProvider = makeProvider();
			await revokedProvider.preview(program);
			revokeOnFinancialRevalidation = true;
			await expect(
				revokedProvider.applyWithAdmission(program, "revoked"),
			).rejects.toMatchObject({ requiresReconciliation: true });
			expect(uncertain).toContain("iac:revoked");
			expect(created).toEqual([]);
			revokeOnFinancialRevalidation = false;
			proxyAuthorized = true;
			await provider.applyWithAdmission(program, "request");
			expect(
				created.filter((entry) => entry.type === Namespace.Type),
			).toHaveLength(1);
			expect(
				created.filter((entry) => entry.type === Worker.Type),
			).toHaveLength(2);
			const proxy = created.find(
				(entry) =>
					"workersDev" in entry.news && entry.news.workersDev === false,
			);
			expect(proxy?.news).toMatchObject({
				workersDev: false,
				domain: null,
				routes: [],
				env: { HOBO_KV_MODE: "read-only", HOBO_KV_ALLOW: "get" },
			});
			const appWorker = created.find(
				(entry) => entry.type === Worker.Type && entry !== proxy,
			);
			expect(appWorker?.news).toMatchObject({
				env: {
					HOBO_RESOURCE_0: expect.objectContaining({ workerName: proxyId }),
				},
			});
			expect(appWorker?.bindings).toMatchObject([
				{
					data: {
						bindings: [
							{ type: "service", name: "HOBO_RESOURCE_0", service: proxyId },
						],
					},
				},
			]);
			expect(proxy?.bindings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						data: expect.objectContaining({
							bindings: [
								expect.objectContaining({
									type: "kv_namespace",
									name: "HOBO_KV_NAMESPACE",
								}),
							],
						}),
					}),
				]),
			);
			const native = nativeNamespace();
			native.values.set("greeting", new TextEncoder().encode("hello"));
			const result = await worker.fetch(new Request("https://app.test"), {
				HOBO_RESOURCE_0: service({
					HOBO_KV_MODE: "read-only",
					HOBO_KV_ALLOW: "get",
					HOBO_KV_NAMESPACE: native.binding,
				}),
			});
			expect(await result.text()).toBe("hello");
		} finally {
			if (before === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = before;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
