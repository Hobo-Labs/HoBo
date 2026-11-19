import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@alchemy.run/cloudflare/D1/Database";
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
	describeCloudflarePrimitiveSupport,
} from "../src/cloudflare.js";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";

const declaration = {
	kind: "data",
	name: "orders",
	stableId: "data:orders",
	declaredAllow: [],
	dependsOn: [],
	annotations: [],
};

function bindle(allow: string[] = []) {
	return {
		name: "shop",
		resources: { orders: { ...declaration, declaredAllow: allow } },
		edges: [],
		requirements: {},
		entrypoint: () => undefined,
	};
}

const options = {
	assessRequirements: () => ({ status: "supported" as const }),
};

function databaseProviders(onApply: () => void = () => {}) {
	const stub = Provider.succeed(Database, {
		reconcile: () =>
			Effect.sync(() => {
				onApply();
				return {
					databaseId: "database",
					databaseName: "orders",
					jurisdiction: "default" as const,
					readReplication: undefined,
					accountId: "account",
					migrationsDir: undefined,
					migrationsTable: undefined,
					migrationsHashes: {},
					importHashes: {},
				};
			}),
		delete: () => Effect.void,
	});
	return Layer.effect(Providers, Provider.collection([Database])).pipe(
		Layer.provide(stub),
	);
}

describe("Cloudflare data infrastructure mapping", () => {
	it("discloses D1 infrastructure without claiming HoBo data operations", () => {
		const [support] = describeCloudflarePrimitiveSupport([
			{ factory: "data", allowVerbs: ["read", "write", "query", "admin"] },
		]);
		expect(support).toMatchObject({
			kind: "data",
			status: "partial",
			resourceTypes: ["Cloudflare.D1Database"],
			supportedOperations: [],
			unsupportedOperations: ["read", "write", "query", "admin"],
			bindsEntrypoint: false,
		});
		expect(support?.reason).toContain("runtime");
	});

	it.each([
		"read",
		"write",
		"query",
		"admin",
	])("rejects a declared %s operation before building infrastructure", (operation) => {
		expect(() =>
			mapBindleToAlchemy(
				bindle([operation]),
				cloudflareBindleMappers({ workerModules: {} }),
				options,
			),
		).toThrow(`operation ${operation}`);
	});

	it("constructs the actual Alchemy D1 resource for an infrastructure-only declaration", async () => {
		const mapped = mapBindleToAlchemy(
			bindle(),
			cloudflareBindleMappers({ workerModules: {} }),
			options,
		);
		const result = await Effect.runPromise(
			Effect.provide(mapped, databaseProviders()).pipe(
				Effect.provideService(StackContext, {
					name: "App",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			),
		);
		expect(result.primary.orders).toMatchObject({
			Type: "Cloudflare.D1Database",
			FQN: "orders",
		});
		expect(result.resources).toHaveLength(1);
	});

	it("includes the D1 resource in the admitted inventory during preview with host stubs", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cloudflare-data-"));
		const previousHome = process.env.ALCHEMY_HOME;
		const previousTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
		try {
			let applied = 0;
			const mapped = mapBindleToAlchemy(
				bindle(),
				cloudflareBindleMappers({ workerModules: {} }),
				options,
			);
			const stack = Stack(
				"App",
				{
					providers: databaseProviders(() => applied++),
					state: inMemoryState(),
				},
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
						resourceId: "orders",
						resourceType: "Cloudflare.D1Database",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "d1",
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
			expect((await provider.preview(program)).changes).toBe(1);
			const assessment = await provider.assessPricing(program);
			expect(assessment.plan.resources).toMatchObject([
				{
					resourceId: "orders",
					providerId: "cloudflare",
					providerAccountRef: "account",
					productId: "d1",
				},
			]);
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
