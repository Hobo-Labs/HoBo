import { createSecretKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Providers } from "@alchemy.run/cloudflare/Providers";
import { Secret } from "@alchemy.run/cloudflare/SecretsStore/Secret";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { mapBindleToAlchemy } from "../src/bindle.js";
import {
	cloudflareBindleMappers,
	cloudflareSecretResourceId,
	describeCloudflarePrimitiveSupport,
} from "../src/cloudflare.js";
import { cloudflareNativeR2BindleMappers } from "../src/cloudflare-native-r2.js";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	type FinancialPlan,
} from "../src/index.js";

const value = "test-only secret value";
const settings = () => ({
	bindleName: "shop",
	resourceName: "api-key",
	accountId: "account",
	storeId: "store",
	secretName: "SHOP_API_KEY",
	value: Redacted.make(value),
});
const options = {
	assessRequirements: () => ({ status: "supported" as const }),
};

function bindle(allow: string[] = []) {
	return {
		name: "shop",
		resources: {
			"api-key": {
				kind: "secret",
				name: "api-key",
				stableId: "secret:api-key",
				declaredAllow: allow,
				dependsOn: [],
				annotations: [],
			},
		},
		edges: [],
		requirements: {},
		entrypoint: () => undefined,
	};
}

function providers(onApply: () => void = () => {}) {
	const secret = Provider.succeed(Secret, {
		reconcile: ({ news }) =>
			Effect.sync(() => {
				onApply();
				return {
					secretId: "secret-id",
					secretName: news.name ?? "secret",
					storeId: news.store.storeId,
					accountId: news.store.accountId,
					status: "active" as const,
					scopes: news.scopes ?? ["workers"],
					comment: undefined,
				};
			}),
		delete: () => Effect.void,
	});
	return Layer.effect(Providers, Provider.collection([Secret])).pipe(
		Layer.provide(secret),
	);
}

describe("Cloudflare Secrets Store infrastructure mapping", () => {
	it("reports the real component without claiming secret runtime operations", () => {
		expect(
			describeCloudflarePrimitiveSupport([
				{ factory: "secret", allowVerbs: ["put", "access"] },
			])[0],
		).toMatchObject({
			kind: "secret",
			status: "partial",
			resourceTypes: ["Cloudflare.SecretsStore.Secret"],
			supportedOperations: [],
			unsupportedOperations: ["put", "access"],
		});
	});

	it("requires explicit settings and rejects unsupported runtime operations", () => {
		expect(() =>
			mapBindleToAlchemy(
				bindle(),
				cloudflareBindleMappers({ workerModules: {} }),
				options,
			),
		).toThrow("SECRET_CONFIG_REQUIRED");
		for (const operation of ["put", "access"])
			expect(() =>
				mapBindleToAlchemy(
					bindle([operation]),
					cloudflareBindleMappers({ workerModules: {}, secrets: [settings()] }),
					options,
				),
			).toThrow(`operation ${operation}`);
	});

	it("retains secret settings when the R2 and KV mappers are composed", () => {
		const mappers = cloudflareNativeR2BindleMappers({
			workerModules: {},
			secrets: [settings()],
			verifyBucket: () => true,
			verifyGrant: () => true,
			kv: { verifyNamespace: () => true, verifyGrant: () => true },
		});
		expect(() => mapBindleToAlchemy(bindle(), mappers, options)).not.toThrow();
	});

	it("does not select a different declaration when array lookup methods change", () => {
		const mapper = cloudflareBindleMappers({
			workerModules: {},
			secrets: [settings()],
		});
		const input = {
			bindleName: "other",
			declaration: bindle().resources["api-key"],
			requirements: {},
			entrypoint: undefined,
			dependencyDeclarations: {},
			dependencies: {},
		};
		const previousSome = Array.prototype.some;
		const previousFind = Array.prototype.find;
		let validationError: unknown;
		let buildError: unknown;
		try {
			Reflect.set(Array.prototype, "some", () => true);
			Reflect.set(Array.prototype, "find", () => settings());
			try {
				mapper.secret.validate(input);
			} catch (error) {
				validationError = error;
			}
			try {
				mapper.secret.build(input);
			} catch (error) {
				buildError = error;
			}
		} finally {
			Reflect.set(Array.prototype, "some", previousSome);
			Reflect.set(Array.prototype, "find", previousFind);
		}
		expect(validationError).toMatchObject({ code: "SECRET_CONFIG_REQUIRED" });
		expect(buildError).toMatchObject({ code: "SECRET_CONFIG_REQUIRED" });
	});

	it("captures an exact redacted secret and creates the Alchemy resource", async () => {
		const config = settings();
		const mapper = cloudflareBindleMappers({
			workerModules: {},
			secrets: [config],
		});
		config.secretName = "changed";
		Redacted.wipeUnsafe(config.value);
		const mapped = mapBindleToAlchemy(bindle(), mapper, options);
		const result = await Effect.runPromise(
			Effect.provide(mapped, providers()).pipe(
				Effect.provideService(StackContext, {
					name: "App",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			),
		);
		const secret = result.primary["api-key"];
		expect(secret).toMatchObject({
			Type: "Cloudflare.SecretsStore.Secret",
			FQN: cloudflareSecretResourceId("shop", "api-key"),
			Props: {
				store: { accountId: "account", storeId: "store" },
				name: "SHOP_API_KEY",
			},
		});
		const captured = secret?.Props.value;
		if (!Redacted.isRedacted(captured))
			throw new Error("missing redacted value");
		expect(Redacted.value(captured)).toBe(value);
		expect(JSON.stringify(secret?.Props)).not.toContain(value);
	});

	it("rejects malformed, duplicate and unredacted definitions", () => {
		for (const secrets of [
			[settings(), settings()],
			[settings(), { ...settings(), resourceName: "other" }],
			[{ ...settings(), value: "plaintext" }],
			[{ ...settings(), storeId: "" }],
			[{ ...settings(), secretName: "../bad" }],
			[{ ...settings(), unexpected: true }],
		])
			expect(() =>
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed values exercise the public settings boundary.
				cloudflareBindleMappers({ workerModules: {}, secrets } as never),
			).toThrow("SECRET_CONFIG_INVALID");
	});

	it("rejects proxies and accessors without invoking them", () => {
		let calls = 0;
		const accessor = settings();
		Object.defineProperty(accessor, "value", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("unexpected getter");
			},
		});
		const proxy = new Proxy(settings(), {
			ownKeys() {
				calls++;
				throw new Error("unexpected proxy trap");
			},
		});
		for (const definition of [accessor, proxy])
			expect(() =>
				cloudflareBindleMappers({ workerModules: {}, secrets: [definition] }),
			).toThrow("SECRET_CONFIG_INVALID");
		expect(calls).toBe(0);
	});

	it("retains settings and duplicate detection when collection methods change", () => {
		const previousPush = Array.prototype.push;
		const previousHas = Set.prototype.has;
		let mapper: ReturnType<typeof cloudflareBindleMappers> | undefined;
		let duplicateError: unknown;
		try {
			Reflect.set(Array.prototype, "push", () => 0);
			Reflect.set(Set.prototype, "has", () => false);
			mapper = cloudflareBindleMappers({
				workerModules: {},
				secrets: [settings()],
			});
			try {
				cloudflareBindleMappers({
					workerModules: {},
					secrets: [settings(), settings()],
				});
			} catch (error) {
				duplicateError = error;
			}
		} finally {
			Reflect.set(Array.prototype, "push", previousPush);
			Reflect.set(Set.prototype, "has", previousHas);
		}
		expect(duplicateError).toMatchObject({ code: "SECRET_CONFIG_INVALID" });
		if (!mapper) throw new Error("missing mapper");
		expect(() => mapBindleToAlchemy(bindle(), mapper, options)).not.toThrow();
	});

	it("derives stable distinct resource identities", () => {
		expect(cloudflareSecretResourceId("shop", "api-key")).toBe(
			cloudflareSecretResourceId("shop", "api-key"),
		);
		expect(cloudflareSecretResourceId("shop", "api-key")).not.toBe(
			cloudflareSecretResourceId("other", "api-key"),
		);
	});

	it("requires authenticated secret fingerprints for preview and includes the resource in pricing inventory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cloudflare-secret-"));
		const previousHome = process.env.ALCHEMY_HOME;
		const previousTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
		try {
			let applied = 0;
			const mapped = mapBindleToAlchemy(
				bindle(),
				cloudflareBindleMappers({ workerModules: {}, secrets: [settings()] }),
				options,
			);
			const stack = Stack(
				"App",
				{ providers: providers(() => applied++), state: inMemoryState() },
				mapped.pipe(Effect.map(() => ({}))),
			);
			const resourceId = cloudflareSecretResourceId("shop", "api-key");
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
						resourceId,
						resourceType: "Cloudflare.SecretsStore.Secret",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "secret",
					},
				],
			});
			const composite = {
				proofRef: "test:scope",
				environmentDigest: `sha256:${"b".repeat(64)}`,
				sourceRequirements: [],
				verifyEnvironment: () => true,
				verifyPlan: () => true,
			};
			const shared = {
				stack,
				target,
				runtimeLayer: Alchemist.layer(),
				stateOwnership: {
					backendRef: "test:state",
					ownershipEpoch: "test:epoch",
					verify: () => true,
				},
				financial: {
					assess: (plan: FinancialPlan) => ({ plan }),
					admit: async () => {
						throw new Error("unexpected admission");
					},
					revalidate: () => false,
					uncertain: () => {},
				},
			};
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
			const noFingerprint = createAlchemyIacProvider({
				...shared,
				composite,
				runtimeDirectory: join(directory, "no-fingerprint"),
			});
			await expect(noFingerprint.preview(program)).rejects.toThrow(
				"PLAN_SECRET_UNVERIFIED",
			);
			const provider = createAlchemyIacProvider({
				...shared,
				composite: {
					...composite,
					secretFingerprint: {
						key: createSecretKey(Buffer.alloc(32, 23)),
						epoch: "epoch",
						proofRef: "key:1",
						verify: () => true,
					},
				},
				runtimeDirectory: join(directory, "verified"),
			});
			const preview = await provider.preview(program);
			expect(preview.changes).toBe(1);
			expect(JSON.stringify(preview)).not.toContain(value);
			const assessment = await provider.assessPricing(program);
			expect(assessment.plan).toMatchObject({ resources: [{ resourceId }] });
			expect(JSON.stringify(assessment)).not.toContain(value);
			expect(applied).toBe(0);
		} finally {
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			if (previousTelemetry === undefined)
				delete process.env.ALCHEMY_TELEMETRY_DISABLED;
			else process.env.ALCHEMY_TELEMETRY_DISABLED = previousTelemetry;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
