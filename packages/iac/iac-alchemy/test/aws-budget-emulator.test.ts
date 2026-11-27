import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { Providers } from "@alchemy.run/aws/Providers";
import { Bucket, BucketProvider } from "@alchemy.run/aws/S3";
import { create } from "@bufbuild/protobuf";
import { NodeHttpClient } from "@effect/platform-node";
import { awsPlugin, getAwsStore } from "@emulators/aws";
import { createServer } from "@emulators/core";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import {
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	HostingPolicyProofSchema,
	IacTargetLiabilityEvidenceSchema,
	IacUnpricedPolicyProofSchema,
	IacUnpricedScopeProofSchema,
} from "../../../broker/src/_generated/yard_placement_pb.js";
import { createSqliteBudgetAdmissionAuthority } from "../../../broker/src/budget-sqlite.js";
import {
	createIacFinancialServices,
	type IacFinancialServicesOptions,
} from "../../../broker/src/iac-financial-services.js";
import type { IacUnpricedAuthorizationInput } from "../../../broker/src/iac-unpriced.js";
import { createDirectRoutePort } from "../../../dispatcher/src/iac-route.js";
import { createSqliteIacRouteAuthority } from "../../../dispatcher/src/iac-route-sqlite.js";
import { rankIacTargets } from "../../../dispatcher/src/iac-target-routing.js";
import {
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "../../../pricing/test/fixtures.js";
import { awsBindleMappers } from "../src/aws.js";
import { mapBindleToAlchemy } from "../src/bindle.js";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	type IacProgram,
} from "../src/index.js";
import { testStateOwnership } from "./route-fixture.js";

const NOW = "2026-01-02T00:00:00Z";
const END = "2026-01-31T23:59:59Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
const program: IacProgram = {
	programId: "run-1",
	deploymentId: "deployment-a",
	resourceId: "application",
	provider: "sandbox",
	driver: "external",
	action: "apply",
	stackName: "Demo",
	operationGeneration: "generation-1",
};
let directory = "";
let previousHome: string | undefined;
let previousTelemetry: string | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hobo-alchemy-budget-"));
	previousHome = process.env.ALCHEMY_HOME;
	previousTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
	process.env.ALCHEMY_HOME = join(directory, "auth");
	process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
});
afterEach(() => {
	if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = previousHome;
	if (previousTelemetry === undefined)
		delete process.env.ALCHEMY_TELEMETRY_DISABLED;
	else process.env.ALCHEMY_TELEMETRY_DISABLED = previousTelemetry;
	rmSync(directory, { recursive: true, force: true });
});

function fixture(
	withPricing: boolean,
	allowUnpriced = false,
	official = false,
) {
	const server = createServer(awsPlugin, { baseUrl: "http://localhost:4566" });
	const credentials = {
		accessKeyId: Redacted.make("local"),
		secretAccessKey: Redacted.make("local"),
	};
	let effects = 0;
	let liabilityRequests = 0;
	const exposuresAtEffects: { reservedMicros: number; unbounded: number }[] =
		[];
	const recordEffect = () => {
		effects++;
		const snapshot = authority.read(NOW);
		exposuresAtEffects.push({
			reservedMicros: snapshot.reservedMicros,
			unbounded: snapshot.unboundedExposureCount,
		});
	};
	const officialEndpoint = official
		? new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "")
		: undefined;
	if (
		officialEndpoint &&
		(officialEndpoint.protocol !== "https:" ||
			!["localhost", "127.0.0.1", "[::1]"].includes(officialEndpoint.hostname))
	)
		throw new Error("expected HTTPS loopback");
	const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
	if (official && !caPath) throw new Error("AWS Emulator CA is required");
	const ca = caPath && official ? readFileSync(caPath) : undefined;
	const observedHttp = Layer.effect(
		HttpClient.HttpClient,
		Effect.map(
			HttpClient.HttpClient,
			HttpClient.tapRequest((req) =>
				Effect.sync(() => {
					if (req.method !== "GET" && req.method !== "HEAD") {
						recordEffect();
					}
				}),
			),
		),
	).pipe(
		Layer.provide(
			NodeHttpClient.layerUndiciOptions({
				connect: { ca, servername: "localhost" },
			}),
		),
	);
	const fetchLayers = official
		? observedHttp
		: Layer.mergeAll(
				FetchHttpClient.layer,
				Layer.succeed(FetchHttpClient.Fetch, (url, init) => {
					if (init?.method !== "GET" && init?.method !== "HEAD") {
						recordEffect();
					}
					return server.app.fetch(new Request(url, init));
				}),
			);
	const awsLayers = Layer.mergeAll(
		Endpoint.of(officialEndpoint?.origin ?? "http://localhost:4566"),
		Credentials.fromCredentials(credentials, "us-east-1"),
		Layer.succeed(
			AWSEnvironment,
			Effect.succeed({
				accountId: "000000000000",
				region: "us-east-1",
				credentials: Effect.succeed({
					...credentials,
					region: "us-east-1",
					sessionToken: undefined,
				}),
			}),
		),
		fetchLayers,
	);
	const stack = Stack(
		"Demo",
		{
			providers: Layer.effect(Providers, Provider.collection([Bucket])).pipe(
				Layer.provideMerge(BucketProvider()),
				Layer.provideMerge(awsLayers),
			),
			state: inMemoryState(),
		},
		mapBindleToAlchemy(
			bindle("shop", (b) => ({ objects: b.bucket() })),
			awsBindleMappers(),
			{ assessRequirements: () => ({ status: "supported" }) },
		).pipe(Effect.map(() => ({}))),
	);

	const authorityOptions: Parameters<
		typeof createSqliteBudgetAdmissionAuthority
	>[0] = {
		path: join(directory, "budget.sqlite"),
		now: () => NOW,
		iacPricedSettlementTrust: { verify: () => false },
		unpricedScopeTrust: {
			verify: (proof) => proof.signature === "scope-signature",
			isCurrent: (proof) => proof.signature === "scope-signature",
			settlement: () => false,
		},
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant-a",
				budgetId: "hosting",
				periodId: "2026-01",
				policyRevision: "r1",
			},
			limitMicros: 3_000_000,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: END,
			providerAccounts: [
				create(BudgetProviderAccountSchema, {
					providerAccountId: "account-a",
					limitMicros: 3_000_000,
				}),
			],
		}),
	};
	const authority = createSqliteBudgetAdmissionAuthority(authorityOptions);
	const scenario = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "0.25")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
	const authorizeUnpriced = (input: IacUnpricedAuthorizationInput) => ({
		gate: { effect: "allow" as const, reasons: [], events: [] },
		proof: create(IacUnpricedPolicyProofSchema, {
			requestDigest: input.requestDigest,
			inventoryHash: input.inventoryHash,
			identity: input.identity,
			policyHash: "policy:1",
			effect: "allow",
			evidenceRef: "unpriced-approval:1",
			obligationsSatisfied: true,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: END,
		}),
		scopeProof: create(IacUnpricedScopeProofSchema, {
			identity: input.identity,
			providerAccountIds: ["account-a"],
			authorityRef: "scope-authority",
			evidenceRef: "exclusive:1",
			ownershipEpoch: "epoch:1",
			observedAt: "2026-01-01T00:00:00Z",
			exclusiveUntilSettled: true,
			noSharedEntitlements: true,
			signature: "scope-signature",
		}),
	});
	const financialOptions: IacFinancialServicesOptions = {
		authority,
		now: () => NOW,
		verifyLiability: () => true,
		issueLiability: ({ inventory, priced }) => {
			liabilityRequests++;
			return create(IacTargetLiabilityEvidenceSchema, {
				evidenceRef: "bound:1",
				targetId: inventory.targetId,
				tenantId: inventory.tenantId,
				planDigest: inventory.planDigest,
				inventoryHash: priced.inventoryHash,
				modelHash: priced.modelHash,
				quoteHash: priced.quote.quoteHash,
				maximumMicros: 1_500_000,
				observedAt: "2026-01-01T00:00:00Z",
				validUntil: END,
				providerAccounts: [
					{ providerAccountId: "account-a", liabilityMicros: 1_500_000 },
				],
			});
		},
		authorize: ({ requestDigest, quote, identity }) => ({
			gate: { effect: "allow", reasons: [], events: [] },
			proof: create(HostingPolicyProofSchema, {
				requestDigest,
				quoteId: quote.quoteId,
				identity,
				effect: "allow",
				policyHash: "policy:1",
				evidenceRef: "gate:1",
				obligationsSatisfied: true,
			}),
		}),
	};
	const configuredOptions: IacFinancialServicesOptions = allowUnpriced
		? { ...financialOptions, unpriced: { authorize: authorizeUnpriced } }
		: financialOptions;
	const financial = createIacFinancialServices(
		withPricing
			? {
					...configuredOptions,
					pricing: {
						modelId: "terms",
						revision: "1",
						scenario,
						bindings: [{ resourceId: "objects", candidateIndex: 0 }],
					},
				}
			: configuredOptions,
	);
	const routeAuthority = createSqliteIacRouteAuthority({
		path: join(directory, "route.sqlite"),
		verifyOperation: () => true,
	});
	const route = createDirectRoutePort({
		authority: routeAuthority,
		hashInventory: (plan: Parameters<typeof financial.assess>[0]) => {
			const hash = financial.assess(plan).inventoryHash;
			if (!hash) throw new Error("inventory hash missing");
			return hash;
		},
	});
	const provider = createAlchemyIacProvider({
		stack,
		target: alchemyTarget({
			targetId: "yard-a",
			tenantId: "tenant-a",
			stackName: "Demo",
			stage: "test",
			programResourceId: "application",
			sourceDigest: DIGEST,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "objects",
					resourceType: Bucket.Type,
					providerId: "sandbox",
					providerAccountRef: "account-a",
					productId: "sandbox",
				},
			],
		}),
		stateOwnership: testStateOwnership,
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: join(directory, "runtime"),
		route,
		resolveRoute: ({ requestId }) => ({
			requestId: requestId ?? "request-1",
			operation: {
				operationId: `sha256:${"f".repeat(64)}`,
				authorization: "host:proof",
			},
		}),
		composite: {
			proofRef: "host:fixture",
			environmentDigest: `sha256:${"e".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: ({ scope, effects, sourceClaims }) =>
				scope.length === 1 && effects.length === 0 && sourceClaims.length === 0,
		},
		financial,
	});
	return {
		provider,
		authority,
		routeAuthority,
		scenario,
		reopenAuthority: () =>
			createSqliteBudgetAdmissionAuthority(authorityOptions),
		effects: () => effects,
		exposuresAtEffects: () => exposuresAtEffects,
		liabilityRequests: () => liabilityRequests,
		server,
	};
}

const official = process.env.HOBO_ALCHEMY_AWS_EMULATOR === "1" ? it : it.skip;

describe("budget routing for an Alchemy AWS bucket", () => {
	async function pricedSelection(f: ReturnType<typeof fixture>) {
		const assessment = await f.provider.assessPricing(program);
		if (
			assessment.pricing.state.case !== "model" ||
			!assessment.pricing.state.value.scenario
		)
			throw new Error("pricing missing");
		const { action, at, horizon } = assessment.pricing.state.value.scenario;
		const ranking = rankIacTargets({
			tenantId: "tenant-a",
			workloadRef: "workload:1",
			action,
			at,
			horizon,
			candidates: [
				{
					workloadRef: "workload:1",
					inventory: assessment.inventory,
					pricing: assessment.pricing,
				},
			],
		});
		const selected = ranking.ranking[0];
		if (!selected) throw new Error("ranking missing");
		const { targetId, inventoryHash, modelHash, quoteHash } = selected;
		return { targetId, inventoryHash, modelHash, quoteHash };
	}
	official(
		"reserves supplied pricing before a successful AWS Emulator apply",
		async () => {
			const f = fixture(true, false, true);
			try {
				const selected = await pricedSelection(f);
				expect(f.effects()).toBe(0);
				const result = await f.provider.applyWithAdmission(
					program,
					"request-1",
					selected,
				);
				expect(result.admission).toMatchObject({
					status: "admitted",
					budget: { evaluation: "allowed", reservation: "held" },
				});
				expect(f.effects()).toBeGreaterThan(0);
				expect(f.exposuresAtEffects()).not.toHaveLength(0);
				expect(
					f
						.exposuresAtEffects()
						.every(
							(entry) =>
								entry.reservedMicros === 1_500_000 && entry.unbounded === 0,
						),
				).toBe(true);
				expect(f.authority.read(NOW).reservedMicros).toBe(1_500_000);
			} finally {
				f.authority.close();
				f.routeAuthority.close();
			}
		},
		30_000,
	);
	it("retains the priced reservation when Vercel's emulator fails after creating the bucket", async () => {
		const f = fixture(true);
		try {
			const selected = await pricedSelection(f);
			await expect(
				f.provider.applyWithAdmission(program, "request-1", selected),
			).rejects.toMatchObject({ code: "APPLY_OUTCOME_UNKNOWN" });
			expect(f.exposuresAtEffects()).not.toHaveLength(0);
			expect(
				f
					.exposuresAtEffects()
					.every(
						(entry) =>
							entry.reservedMicros === 1_500_000 && entry.unbounded === 0,
					),
			).toBe(true);
			expect(f.authority.read(NOW).reservedMicros).toBe(1_500_000);
			expect(getAwsStore(f.server.store).s3Buckets.all()).toHaveLength(1);
		} finally {
			f.authority.close();
			f.routeAuthority.close();
		}
	}, 30_000);
	it("denies missing pricing before an emulator mutation", async () => {
		const f = fixture(false);
		try {
			const assessment = await f.provider.assessPricing(program);
			expect(assessment).toMatchObject({
				pricing: { state: { case: "unavailable" } },
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			const { action, at, horizon } = f.scenario;
			expect(
				rankIacTargets({
					tenantId: "tenant-a",
					workloadRef: "workload:1",
					action,
					at,
					horizon,
					candidates: [
						{
							workloadRef: "workload:1",
							inventory: assessment.inventory,
							pricing: assessment.pricing,
						},
					],
				}),
			).toMatchObject({
				ranking: [],
				rejected: [{ targetId: "yard-a", code: "PRICING_MODEL_UNAVAILABLE" }],
			});
			await expect(f.provider.apply(program)).rejects.toMatchObject({
				code: "PRICING_MODEL_UNAVAILABLE",
			});
			expect(f.effects()).toBe(0);
			expect(f.authority.read(NOW).reservedMicros).toBe(0);
			expect(getAwsStore(f.server.store).s3Buckets.all()).toHaveLength(0);
		} finally {
			f.authority.close();
			f.routeAuthority.close();
		}
	}, 30_000);
	it("retains unbounded exposure when explicitly admitted unpriced apply has an unknown outcome", async () => {
		const f = fixture(false, true);
		try {
			await f.provider.assessPricing(program);
			await expect(
				f.provider.applyWithAdmission(program, "request-1"),
			).rejects.toMatchObject({ code: "APPLY_OUTCOME_UNKNOWN" });
			expect(f.exposuresAtEffects()).not.toHaveLength(0);
			expect(
				f
					.exposuresAtEffects()
					.every(
						(entry) => entry.reservedMicros === 0 && entry.unbounded === 1,
					),
			).toBe(true);
			expect(f.authority.read(NOW).unboundedExposureCount).toBe(1);
			expect(f.liabilityRequests()).toBe(0);
			expect(getAwsStore(f.server.store).s3Buckets.all()).toHaveLength(1);
		} finally {
			f.authority.close();
			f.routeAuthority.close();
		}
	}, 30_000);
});
