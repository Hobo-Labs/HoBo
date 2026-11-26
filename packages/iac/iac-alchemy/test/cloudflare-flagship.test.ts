import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "@alchemy.run/cloudflare/Flagship/App";
import { Flag } from "@alchemy.run/cloudflare/Flagship/Flag";
import { Providers } from "@alchemy.run/cloudflare/Providers";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { mapBindleToAlchemy } from "../src/bindle.js";
import {
	cloudflareBindleMappers,
	cloudflareFlagshipResourceIds,
	describeCloudflarePrimitiveSupport,
} from "../src/cloudflare.js";
import { cloudflareNativeR2BindleMappers } from "../src/cloudflare-native-r2.js";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";

const settings = {
	bindleName: "shop",
	resourceName: "beta",
	enabled: true,
	defaultValue: false,
};
const ids = cloudflareFlagshipResourceIds("shop", "beta");
const options = {
	assessRequirements: () => ({ status: "supported" as const }),
};

function bindle(allow: string[] = []) {
	return {
		name: "shop",
		resources: {
			beta: {
				kind: "flag",
				name: "beta",
				stableId: "flag:beta",
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
	const app = Provider.succeed(App, {
		reconcile: () =>
			Effect.sync(() => {
				onApply();
				return {
					appId: "app-id",
					accountId: "account",
					name: "app",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					updatedBy: "test",
				};
			}),
		delete: () => Effect.void,
	});
	const flag = Provider.succeed(Flag, {
		reconcile: ({ news }) =>
			Effect.sync(() => {
				onApply();
				return {
					appId: news.appId,
					accountId: "account",
					key: news.key ?? "beta",
					enabled: news.enabled ?? true,
					defaultVariation: news.defaultVariation,
					variations: news.variations,
					rules: [],
					description: undefined,
					type: "boolean" as const,
					updatedAt: undefined,
					updatedBy: undefined,
				};
			}),
		delete: () => Effect.void,
	});
	return Layer.effect(Providers, Provider.collection([App, Flag])).pipe(
		Layer.provide(Layer.merge(app, flag)),
	);
}

describe("Cloudflare Flagship infrastructure mapping", () => {
	it("reports a partial component mapping and no HoBo runtime operations", () => {
		const [row] = describeCloudflarePrimitiveSupport([
			{ factory: "flag", allowVerbs: ["eval", "change"] },
		]);
		expect(row).toMatchObject({
			kind: "flag",
			status: "partial",
			resourceTypes: ["Cloudflare.Flagship.App", "Cloudflare.Flagship.Flag"],
			supportedOperations: [],
			unsupportedOperations: ["eval", "change"],
		});
		expect(row?.reason).toMatch(/explicit.*runtime/iu);
	});

	it("requires an explicit definition and refuses runtime operations", () => {
		expect(() =>
			mapBindleToAlchemy(
				bindle(),
				cloudflareBindleMappers({ workerModules: {} }),
				options,
			),
		).toThrow(/explicit/iu);
		for (const operation of ["eval", "change"]) {
			expect(() =>
				mapBindleToAlchemy(
					bindle([operation]),
					cloudflareBindleMappers({
						workerModules: {},
						flagshipFlags: [settings],
					}),
					options,
				),
			).toThrow(`operation ${operation}`);
		}
	});

	it("rejects duplicate, malformed and sparse definitions before mapping", () => {
		const sparse = [{ ...settings }];
		sparse.length = 2;
		for (const flagshipFlags of [
			[settings, settings],
			[{ ...settings, resourceName: "Not-lowercase" }],
			[{ ...settings, unexpected: "ignored" }],
			sparse,
		])
			expect(() =>
				cloudflareBindleMappers({ workerModules: {}, flagshipFlags }),
			).toThrow("FLAGSHIP_CONFIG_INVALID");
	});

	it("rejects proxies and accessors without invoking them", () => {
		let calls = 0;
		const proxy = new Proxy(
			{ ...settings },
			{
				ownKeys() {
					calls++;
					throw new Error("unexpected trap");
				},
			},
		);
		const accessor = { ...settings };
		Object.defineProperty(accessor, "defaultValue", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("unexpected getter");
			},
		});
		for (const entry of [proxy, accessor])
			expect(() =>
				cloudflareBindleMappers({ workerModules: {}, flagshipFlags: [entry] }),
			).toThrow("FLAGSHIP_CONFIG_INVALID");
		expect(calls).toBe(0);
	});

	it("keeps flag definitions when the R2 and KV mappers are composed", () => {
		const mappers = cloudflareNativeR2BindleMappers({
			workerModules: {},
			flagshipFlags: [settings],
			verifyBucket: () => true,
			verifyGrant: () => true,
			kv: { verifyNamespace: () => true, verifyGrant: () => true },
		});
		expect(() => mapBindleToAlchemy(bindle(), mappers, options)).not.toThrow();
	});

	it("derives distinct durable identities from both bindle and flag names", () => {
		expect(cloudflareFlagshipResourceIds("shop", "beta")).toEqual(ids);
		expect(cloudflareFlagshipResourceIds("other", "beta")).not.toEqual(ids);
		expect(cloudflareFlagshipResourceIds("shop", "another")).not.toEqual(ids);
		expect(() => cloudflareFlagshipResourceIds("shop", "../bad")).toThrow(
			"FLAGSHIP_CONFIG_INVALID",
		);
	});

	it("constructs Alchemy's actual app and boolean flag, capturing the settings", async () => {
		const config = { ...settings };
		const mappers = cloudflareBindleMappers({
			workerModules: {},
			flagshipFlags: [config],
		});
		config.defaultValue = true;
		const mapping = mapBindleToAlchemy(bindle(), mappers, options);
		const result = await Effect.runPromise(
			Effect.provide(mapping, providers()).pipe(
				Effect.provideService(StackContext, {
					name: "App",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			),
		);
		expect(
			result.resources.map((resource) => [resource.Type, resource.FQN]),
		).toEqual([
			["Cloudflare.Flagship.App", ids.app],
			["Cloudflare.Flagship.Flag", ids.flag],
		]);
		expect(result.primary.beta).toMatchObject({
			Type: "Cloudflare.Flagship.Flag",
			Props: {
				key: "beta",
				enabled: true,
				defaultVariation: "disabled",
				variations: { disabled: false, enabled: true },
			},
		});
	});

	it("includes both Flagship resources in preview and the pricing inventory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cloudflare-flagship-"));
		const previousHome = process.env.ALCHEMY_HOME;
		const previousTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
		try {
			let applied = 0;
			const mapping = mapBindleToAlchemy(
				bindle(),
				cloudflareBindleMappers({
					workerModules: {},
					flagshipFlags: [settings],
				}),
				options,
			);
			const stack = Stack(
				"App",
				{ providers: providers(() => applied++), state: inMemoryState() },
				mapping.pipe(Effect.map(() => ({}))),
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
						resourceId: ids.app,
						resourceType: "Cloudflare.Flagship.App",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "flagship-app",
					},
					{
						resourceId: ids.flag,
						resourceType: "Cloudflare.Flagship.Flag",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "flagship-flag",
					},
				],
			});
			const provider = createAlchemyIacProvider({
				stack,
				target,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: join(directory, "runtime"),
				stateOwnership: {
					backendRef: "test:state",
					ownershipEpoch: "test:epoch",
					verify: () => true,
				},
				composite: {
					proofRef: "test:scope",
					environmentDigest: `sha256:${"b".repeat(64)}`,
					sourceRequirements: [],
					verifyEnvironment: () => true,
					verifyPlan: () => true,
				},
				financial: {
					assess: (plan) => ({ plan }),
					admit: async () => {
						throw new Error("unexpected admission");
					},
					revalidate: () => false,
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
			expect((await provider.preview(program)).changes).toBe(2);
			const assessment = await provider.assessPricing(program);
			expect(
				assessment.plan.resources.map((resource) => resource.resourceId).sort(),
			).toEqual([ids.app, ids.flag].sort());
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
