import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Table } from "@alchemy.run/aws/DynamoDB";
import { WebFunction } from "@alchemy.run/aws/Lambda";
import { Providers } from "@alchemy.run/aws/Providers";
import { Bucket } from "@alchemy.run/aws/S3";
import { Secret } from "@alchemy.run/aws/SecretsManager";
import { create } from "@bufbuild/protobuf";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import type { ResourceClass, ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import {
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
} from "../../../broker/src/_generated/yard_placement_pb.js";
import { createSqliteBudgetAdmissionAuthority } from "../../../broker/src/budget-sqlite.js";
import { createIacFinancialServices } from "../../../broker/src/iac-financial-services.js";
import { rankIacTargets } from "../../../dispatcher/src/iac-target-routing.js";
import {
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "../../../pricing/test/fixtures.js";
import {
	awsHttpBindleMappers,
	awsWebFunctionSource,
} from "../src/aws-http-mapper.js";
import { defineAwsHttpSource } from "../src/aws-http-source.js";
import {
	awsDynamoKvBindleMappers,
	withAwsDynamoKv,
} from "../src/aws-kv-mapper.js";
import { awsS3BindleMappers, withAwsS3 } from "../src/aws-s3-mapper.js";
import {
	awsVersionedSecretBindleMappers,
	withAwsVersionedSecret,
} from "../src/aws-secret-mapper.js";
import { mapBindleToAlchemy } from "../src/bindle.js";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { testStateOwnership } from "./route-fixture.js";

function stub<R extends ResourceLike>(resource: ResourceClass<R>) {
	return Provider.succeed(resource, {
		reconcile: () => Effect.die(new Error("unexpected provider effect")),
		delete: () => Effect.void,
	});
}

it("prices the entire mapped AWS application or explicitly rejects it as unavailable", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-aws-http-pricing-"));
	const previous = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = join(directory, "auth");
	const now = "2026-01-02T00:00:00Z";
	const end = "2026-01-31T23:59:59Z";
	const authority = createSqliteBudgetAdmissionAuthority({
		path: join(directory, "budget.sqlite"),
		now: () => now,
		iacPricedSettlementTrust: { verify: () => false },
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant-a",
				budgetId: "hosting",
				periodId: "2026-01",
				policyRevision: "r1",
			},
			limitMicros: 10_000_000,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: end,
			providerAccounts: [
				create(BudgetProviderAccountSchema, {
					providerAccountId: "account-a",
					limitMicros: 10_000_000,
				}),
			],
		}),
	});
	try {
		const neutral = bindle("shop", (b) => {
			const objects = b.bucket().allow("read");
			const sessions = b.kv().allow("get");
			const credentials = b.secret().allow("access");
			return {
				credentials,
				objects,
				sessions,
				web: b
					.web(() => () => new Response("ok"))
					.with(sessionReplay({ enabled: false }))
					.dependsOn(objects, sessions, credentials),
			};
		});
		const selected = withAwsVersionedSecret(
			withAwsS3(withAwsDynamoKv(neutral, { sessions: true }), {
				objects: true,
			}),
			{ credentials: true },
		);
		const source = defineAwsHttpSource({
			bindle: selected,
			applicationName: "web",
			environment: {},
			resolveStores: () => ({}),
			verifyBinding: () => true,
		});
		const main = fileURLToPath(import.meta.url);
		const sourceDigest = `sha256:${"a".repeat(64)}`;
		const environmentDigest = `sha256:${"b".repeat(64)}`;
		const fence = {
			sourceDigest,
			environmentDigest,
			proofRef: "host:test",
			verify: () => true,
		};
		const mappers = awsHttpBindleMappers(
			{
				source,
				main,
				authType: "IamAuth",
				maxEnvironments: 2,
				rateLimit: 100,
				sourceFence: fence,
				verifySource: () => true,
			},
			awsVersionedSecretBindleMappers(
				awsS3BindleMappers(awsDynamoKvBindleMappers()),
			),
		);
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "0.25")],
			candidate: [
				workload("agreement-a", [usage("minute", "1", "minute")]),
				workload("agreement-a", [usage("minute", "2", "minute")]),
				workload("agreement-a", [usage("minute", "3", "minute")]),
				workload("agreement-a", [usage("minute", "1", "minute")]),
			],
		});
		const bindings = [
			{ resourceId: "objects", candidateIndex: 0 },
			{ resourceId: "sessions", candidateIndex: 1 },
			{ resourceId: "web", candidateIndex: 2 },
			{ resourceId: "credentials", candidateIndex: 3 },
		];
		const target = alchemyTarget({
			targetId: "yard-a",
			tenantId: "tenant-a",
			stackName: "Demo",
			stage: "test",
			programResourceId: "application",
			sourceDigest,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "credentials",
					resourceType: Secret.Type,
					providerId: "sandbox",
					providerAccountRef: "account-a",
					productId: "sandbox",
				},
				{
					resourceId: "objects",
					resourceType: Bucket.Type,
					providerId: "sandbox",
					providerAccountRef: "account-a",
					productId: "sandbox",
				},
				{
					resourceId: "sessions",
					resourceType: Table.Type,
					providerId: "sandbox",
					providerAccountRef: "account-a",
					productId: "sandbox",
				},
				{
					resourceId: "web",
					resourceType: WebFunction.Type,
					providerId: "sandbox",
					providerAccountRef: "account-a",
					productId: "sandbox",
				},
			],
		});
		const composite = {
			proofRef: "host:test",
			environmentDigest,
			sourceRequirements: [awsWebFunctionSource("shop", "web", main)],
			verifyEnvironment: () => true,
			verifyPlan: ({ sourceClaims }: { sourceClaims: readonly unknown[] }) =>
				sourceClaims.length === 1,
		};
		const providers = Layer.effect(
			Providers,
			Provider.collection([Bucket, Table, Secret, WebFunction]),
		).pipe(
			Layer.provide(
				Layer.mergeAll(
					stub(Bucket),
					stub(Table),
					stub(Secret),
					Provider.succeed(WebFunction, {
						reconcile: () =>
							Effect.die(new Error("unexpected web function effect")),
						delete: () => Effect.void,
					}),
				),
			),
		);
		const program = {
			programId: "p",
			deploymentId: "d",
			resourceId: "application",
			provider: "sandbox",
			driver: "external",
			action: "apply" as const,
			stackName: "Demo",
		};
		async function assessment(mode: "unknown" | "partial" | "complete") {
			const base = { authority, now: () => now };
			const financial =
				mode === "unknown"
					? createIacFinancialServices(base)
					: createIacFinancialServices({
							...base,
							pricing: {
								modelId: "terms",
								revision: "1",
								scenario,
								bindings: mode === "partial" ? bindings.slice(0, 3) : bindings,
							},
						});
			const programEffect = mapBindleToAlchemy(selected, mappers, {
				assessRequirements: () => ({ status: "supported" }),
			});
			const stack = Stack(
				"Demo",
				{ providers, state: inMemoryState() },
				programEffect.pipe(Effect.map(() => ({}))),
			);
			const provider = createAlchemyIacProvider({
				stack,
				target,
				stateOwnership: testStateOwnership,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: join(directory, mode),
				composite,
				financial,
			});
			return provider.assessPricing(program);
		}
		const rank = (result: Awaited<ReturnType<typeof assessment>>) =>
			rankIacTargets({
				tenantId: "tenant-a",
				workloadRef: "workload:1",
				action: scenario.action,
				at: scenario.at,
				horizon: scenario.horizon,
				candidates: [
					{
						workloadRef: "workload:1",
						inventory: result.inventory,
						pricing: result.pricing,
					},
				],
			});
		const unknown = await assessment("unknown");
		expect(
			unknown.inventory.resources.map((entry) => entry.resourceId).sort(),
		).toEqual(["credentials", "objects", "sessions", "web"]);
		expect(rank(unknown)).toMatchObject({
			ranking: [],
			rejected: [{ code: "PRICING_MODEL_UNAVAILABLE" }],
		});
		const partial = await assessment("partial");
		expect(rank(partial)).toMatchObject({
			ranking: [],
			rejected: [{ code: "TARGET_PRICING_INCOMPLETE" }],
		});
		const complete = await assessment("complete");
		expect(rank(complete).ranking).toHaveLength(1);
		expect(authority.read(now).reservedMicros).toBe(0);
	} finally {
		authority.close();
		if (previous === undefined) delete process.env.ALCHEMY_HOME;
		else process.env.ALCHEMY_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}, 30_000);
