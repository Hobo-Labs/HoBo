/** Actual adapter composition over a modeled GCP REST service and a separately
 * signed financial integration. This is local acceptance, not a paid/live API run. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import {
	HostingTransitionAction as Action,
	type DeploymentPlan,
	type HostingOperationRequest,
	HostingTransitionPlanSchema,
	hashDeploymentPlan,
} from "@hobo/cloud";
import { createSimpleTrafficRouting } from "@hobo/connectivity";
import {
	canonicalJson,
	createBoundedFetchTransport,
	type HttpTransport,
	parseRoutingPlan,
} from "@hobo/core";
import { GCP_CLOUD_RUN_PRODUCT_ID } from "@hobo/provider-gcp";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	HostingFinancialEvidenceAttestationSchema,
	HostingFinancialEvidenceClaimsSchema,
} from "../src/_generated/hosting_financial_evidence_pb.js";
import {
	createDurableHostingCredentialScopeReplayStore,
	createHostingCredentialScopeIssuer,
	createHostingCredentialScopeVerifier,
	createVerifiedHostingCredentialLease,
} from "../src/hosting-credential-scope.js";
import {
	createHostingFinancialEvidenceReader,
	hostingFinancialEvidenceSigningPayload,
} from "../src/hosting-financial-evidence.js";
import { createDurableHostingMutationJournal } from "../src/hosting-mutation-journal.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
} from "../src/json.js";
import { createProductionHostingProviderCatalog } from "../src/provider-hosting-catalog.js";
import {
	createResolverHostingTransitionProvider,
	type HostingOperatingLiabilityReader,
	type HostingResourceLifecycleReader,
} from "../src/resolver-hosting-provider.js";

const dispose: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (dispose.length) await dispose.pop()?.();
});
const digest = (value: string) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
async function fixture(
	alias: "gcp" | "@hobo/provider-gcp",
	foreignAccount = false,
) {
	const dataDir = mkdtempSync(join(tmpdir(), "signed-hosting-alias-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const store = createRuntimeLocalEventStore({
		dataDir,
		clock: createManualClock("2026-10-30T00:00:00Z"),
	});
	dispose.push(() => store.close());
	const actor = { kind: "service", id: "alias-integration" } as const,
		context = { tenantId: "tenant", actor, fenceToken: 1n };
	let nowMs = 1000;
	const source: DeploymentPlan = {
		schema: "hobo.deployment-plan/v1",
		objective: "min-cost",
		dependencyOrder: [],
		resources: [],
	};
	const contentDigest = `sha256:${"b".repeat(64)}`,
		image = `us-docker.pkg.dev/project-one/images/app@${contentDigest}`;
	const target: DeploymentPlan = {
		schema: "hobo.deployment-plan/v1",
		objective: "min-cost",
		dependencyOrder: ["app"],
		resources: [
			{
				name: "app",
				provider: alias,
				port: "compute",
				productId: GCP_CLOUD_RUN_PRODUCT_ID,
				deps: [],
				realizationParameters: {
					location: "us-central1",
					image,
					serviceAccount: "hosting@project-one.iam.gserviceaccount.com",
					cpu: "1",
					memory: "512Mi",
					minInstances: 0,
					maxInstances: 1,
					concurrency: 4,
					ingress: "all",
				},
			},
		],
	};
	const sourceHash = hashDeploymentPlan(source),
		targetHash = hashDeploymentPlan(target),
		endpoint = "https://target-service-abc.a.run.app/";
	let approvedResourceId = "",
		physicalId = "";
	const publicLiability = {
		resourceName: "app",
		providerId: "gcp",
		providerAccountId: "account",
		artifactDigest: contentDigest,
		mode: "provider-funded-zero",
		evidenceRef: "native://irrevocable/provider-funded-entitlement",
		expiresAtMs: 0,
		maximumMicros: 0,
	};
	const plan = create(HostingTransitionPlanSchema, {
		schemaVersion: "hobo.hosting-transition/v1",
		tenantId: "tenant",
		transitionId: "transition",
		deploymentId: "deployment",
		sourceIncarnationId: "prior-life",
		sourcePlanId: sourceHash,
		targetPlanId: targetHash,
		planDigest: digest(`approved-plan:${alias}`),
		horizonEndMs: 50000,
		operationTimeoutMs: 5000,
		constraints: {
			movementClass: "stateless",
			minimumHealthyBackends: 1,
			allowedJurisdictions: ["US"],
			maximumLatencyMs: 1000,
			observationMaxAgeMs: 60000,
			requiredCapabilityDigest: "capabilities:fixture",
		},
		destinationLiabilities: [{ ...publicLiability, providerId: alias }],
		commitment: {
			currency: "USD",
			evidence: {
				quotes: [
					{
						id: "quote-app",
						resourceName: "app",
						providerId: alias,
						providerAccountId: "account",
						currency: "USD",
					},
				],
			},
			allocations: [
				{
					resourceName: "app",
					quoteId: "quote-app",
					providerAccountId: "account",
					providerCharges: [
						{
							providerAccountId: "account",
							expectedMicros: 0,
							reservedMicros: 0,
						},
					],
				},
			],
		},
	});
	const financialKeys = generateKeyPairSync("ed25519");
	let native: JsonObject | undefined,
		writes = 0;
	const financialQueries: JsonObject[] = [];
	const server = createServer((incoming, response) => {
		let text = "";
		incoming.setEncoding("utf8");
		incoming.on("data", (chunk) => {
			text += chunk;
		});
		incoming.on("end", () => {
			const requested = new URL(incoming.url ?? "/", "http://fixture.local"),
				path = requested.pathname;
			response.setHeader("content-type", "application/json");
			if (path === "/financial") {
				const query = parseJsonObject(text);
				financialQueries.push(query);
				nowMs += 10;
				const binding = {
					artifactId: targetHash,
					resourceName: "app",
					productId: GCP_CLOUD_RUN_PRODUCT_ID,
					resourceId: approvedResourceId,
					physicalId,
					artifactDigest: contentDigest,
				};
				const lifecycles = [];
				if (native) {
					const nativeName = native.name,
						nativeUri = native.uri,
						operationId = query.operationId;
					if (
						!isJsonString(nativeName) ||
						!isJsonString(nativeUri) ||
						!isJsonString(operationId)
					) {
						response.statusCode = 500;
						response.end("{}");
						return;
					}
					const template = native.template,
						container =
							isJsonObject(template) && Array.isArray(template.containers)
								? template.containers[0]
								: undefined;
					const actualImage =
						isJsonObject(container) && isJsonString(container.image)
							? container.image
							: "";
					lifecycles.push({
						binding,
						observationJson: canonicalJson({
							tenantId: "tenant",
							providerId: "gcp",
							providerAccountId: "account",
							productId: GCP_CLOUD_RUN_PRODUCT_ID,
							resourceId: approvedResourceId,
							physicalId: nativeName,
							operationId,
							status: "ready",
							observedAtMs: nowMs,
							evidenceRef: "native://gcp/readback",
							artifactDigest: actualImage.split("@")[1] ?? "",
							operationTerminal: true,
							billable: false,
							healthy: false,
							usageFinal: query.operationId === "transition/SETTLE",
							settledMicros: 0,
							usageEvidenceRef:
								query.operationId === "transition/SETTLE"
									? "billing://closed/provider-funded-zero"
									: "",
							servingEndpoint: nativeUri,
						}),
					});
				}
				const claims = create(HostingFinancialEvidenceClaimsSchema, {
					schemaVersion: "hobo.hosting-financial-evidence/v1",
					proofId: `proof-${nowMs}`,
					issuerId: "billing-integration",
					keyId: "billing-key",
					tenantId: "tenant",
					providerId: "gcp",
					providerAccountId: foreignAccount ? "foreign-account" : "account",
					currency: "USD",
					operationId: isJsonString(query.operationId) ? query.operationId : "",
					operationDigest: isJsonString(query.operationDigest)
						? query.operationDigest
						: "",
					planDigest: isJsonString(query.planDigest) ? query.planDigest : "",
					issuedAtMs: nowMs,
					expiresAtMs: nowMs + 10000,
					lifecycles,
					liabilities: [
						{
							binding,
							liabilityJson: canonicalJson(publicLiability),
							finalized: true,
						},
					],
				});
				const proof = create(HostingFinancialEvidenceAttestationSchema, {
					claims,
					signature: `ed25519:${sign(null, Buffer.from(hostingFinancialEvidenceSigningPayload(claims)), financialKeys.privateKey).toString("base64url")}`,
				});
				response.end(
					JSON.stringify(
						toJson(HostingFinancialEvidenceAttestationSchema, proof),
					),
				);
				return;
			}
			if (path === "/health") {
				response.end(
					JSON.stringify({
						healthy: true,
						tenantId: "tenant",
						artifactDigest: targetHash,
						healthyBackends: 1,
						jurisdiction: "US",
						capabilityDigest: "capabilities:fixture",
					}),
				);
				return;
			}
			if (incoming.headers.authorization !== "Bearer pinned-gcp-token") {
				response.statusCode = 403;
				response.end("{}");
				return;
			}
			if (incoming.method === "POST") {
				writes++;
				const body = parseJsonObject(text);
				const nativeName = requested.searchParams.get("serviceId");
				if (!nativeName) {
					response.statusCode = 400;
					response.end("{}");
					return;
				}
				native = {
					...body,
					name: `projects/project-one/locations/us-central1/services/${nativeName}`,
					uri: endpoint,
					generation: "1",
					observedGeneration: "1",
					reconciling: false,
					terminalCondition: { state: "CONDITION_SUCCEEDED" },
					etag: "native-revision-1",
				};
				response.end(
					JSON.stringify({
						name: "projects/project-one/locations/us-central1/operations/create-one",
						done: true,
					}),
				);
				return;
			}
			if (!native) {
				response.statusCode = 404;
				response.end("{}");
				return;
			}
			response.end(JSON.stringify(native));
		});
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
		throw new Error("missing HTTP fixture address");
	const origin = `http://127.0.0.1:${address.port}`,
		bounded = createBoundedFetchTransport({ fetchImpl: globalThis.fetch });
	const nativeTransport: HttpTransport = (request) =>
		bounded({
			...request,
			url: `${origin}${new URL(request.url).pathname}${new URL(request.url).search}`,
		});
	const healthTransport: HttpTransport = (request) =>
		bounded({ ...request, url: `${origin}/health` });
	async function lease(
		providerId: string,
		nativeAccountRef: string,
		material: string,
	) {
		const keys = generateKeyPairSync("ed25519"),
			identity = {
				tenantId: "tenant",
				providerId,
				providerAccountId: "account",
				nativeAccountRef,
			},
			credentialRef = `vault://alias/${providerId}`;
		const issuer = createHostingCredentialScopeIssuer({
			issuerId: `issuer-${providerId}`,
			keyId: "issuer-key",
			privateKey: keys.privateKey,
			bindings: [
				{
					identity,
					credentialRef,
					credentialVersion: "v1",
					credential: material,
					evidenceRef: "inventory://native-account",
					observedAtMs: 900,
					validUntilMs: 100000,
				},
			],
		});
		return createVerifiedHostingCredentialLease({
			request: { ...identity, credentialRef, operationId: "initial", nowMs },
			resolveCredential: async () => ({ version: "v1", material }),
			attest: issuer.attest,
			verifier: createHostingCredentialScopeVerifier({
				trust: [
					{
						issuerId: `issuer-${providerId}`,
						keyId: "issuer-key",
						publicKey: keys.publicKey,
						identities: [identity],
					},
				],
				replayStore: createDurableHostingCredentialScopeReplayStore({
					...context,
					store,
				}),
				nowMs: () => nowMs,
			}),
		});
	}
	function financialReader(resourceId: string) {
		if (
			!resourceId ||
			(approvedResourceId && approvedResourceId !== resourceId)
		)
			throw new Error("approved native identity changed");
		approvedResourceId = resourceId;
		physicalId = `projects/project-one/locations/us-central1/services/${resourceId}`;
		return createHostingFinancialEvidenceReader({
			...context,
			store,
			transport: bounded,
			sources: [
				{
					issuerId: "billing-integration",
					keyId: "billing-key",
					publicKey: financialKeys.publicKey,
					tenantId: "tenant",
					providerId: "gcp",
					providerAccountId: "account",
					currency: "USD",
					endpoint: `${origin}/financial`,
					resources: [
						{
							artifactId: targetHash,
							resourceName: "app",
							productId: GCP_CLOUD_RUN_PRODUCT_ID,
							resourceId: approvedResourceId,
							physicalId,
							artifactDigest: contentDigest,
						},
					],
				},
			],
			nowMs: () => nowMs,
			allowInsecureLoopback: true,
		});
	}
	const providers = createProductionHostingProviderCatalog([
		{
			providerId: "gcp",
			lease: await lease(
				"gcp",
				"gcp://projects/project-one",
				"pinned-gcp-token",
			),
			options: { projectId: "project-one" },
			transport: nativeTransport,
			observeOperatingLiability: (
				input: Parameters<HostingOperatingLiabilityReader>[0],
			) => financialReader(input.resourceId).observeOperatingLiability(input),
			observeLifecycle: (
				input: Parameters<HostingResourceLifecycleReader>[0],
			) => financialReader(input.resourceId).observeLifecycle(input),
		},
	]);
	const routeLease = await lease(
			"simple",
			"local://station/router",
			"local-routing-token",
		),
		router = createSimpleTrafficRouting();
	const backends = [{ id: "backend-app", service: "app", endpoint }],
		targetRoute = parseRoutingPlan({
			planId: "route-target",
			createdAt: "2026-10-30T00:00:00Z",
			backends,
			intent: {
				service: "app",
				tenantId: "tenant",
				rules: [{ backends, weightStrategy: "static" }],
			},
		}),
		sourceRoute = parseRoutingPlan({
			...parseJsonObject(JSON.stringify(targetRoute)),
			planId: "route-source",
		});
	const journal = createDurableHostingMutationJournal({
		...context,
		store,
		nowMs: () => nowMs,
	});
	const provider = createResolverHostingTransitionProvider({
		store,
		context,
		mutationJournal: journal,
		artifacts: new Map([
			[sourceHash, source],
			[targetHash, target],
		]),
		resourceArtifacts: new Map([
			[sourceHash, new Map()],
			[targetHash, new Map([["app", contentDigest]])],
		]),
		providers,
		routing: new Map([
			[
				"deployment",
				{
					port: router,
					source: sourceRoute,
					target: targetRoute,
					providerAccountId: "account",
					credentialRef: routeLease.credentialRef,
					verifyCredentialScope: routeLease.verifyCredentialScope,
				},
			],
		]),
		health: new Map([
			[targetHash, { url: endpoint, transport: healthTransport }],
		]),
		billing: {
			observe: (request: HostingOperationRequest) =>
				financialReader(approvedResourceId).billing.observe(request),
		},
		nowMs: () => nowMs,
	});
	function phase(action: Action): HostingOperationRequest {
		return {
			plan,
			operation: {
				$typeName: "hobo.cloud.hosting.v1.HostingTransitionOperation",
				operationId: `transition/${Action[action]}`,
				operationDigest: digest(`operation:${action}`),
				action,
				startedAtMs: nowMs,
				deadlineAtMs: 50000,
				observationAttempts: 0,
				nextObservationAtMs: 0,
				mutationDispatched: true,
				mutationResumes: 0,
			},
			reservationId: "held-fixture",
			fenceToken: 1n,
			signal: new AbortController().signal,
		};
	}
	return {
		provider,
		phase,
		router,
		targetRoute,
		financialQueries,
		writes: () => writes,
		native: () => native,
	};
}
describe("signed financial evidence across native and manifest provider aliases", () => {
	it.each([
		"gcp",
		"@hobo/provider-gcp",
	] as const)("runs actual signedreader/catalog/GCP resolver and routes the observed native endpoint for %s", async (alias) => {
		const f = await fixture(alias),
			prepare = f.phase(Action.PREPARE);
		await f.provider.execute(prepare);
		expect(f.writes()).toBe(1);
		const native = f.native();
		if (!native) throw new Error("native service missing");
		const annotations = native.annotations;
		expect(annotations).toMatchObject({
			"hobo.dev/artifact": prepare.plan.targetPlanId,
		});
		const prepared = await f.provider.observe(prepare);
		expect(prepared).toMatchObject({
			ready: true,
			destinationLiabilityFinalized: true,
			healthyBackends: 1,
		});
		expect(prepared.destinationLiabilities?.[0]?.providerId).toBe(alias);
		const shift = f.phase(Action.SHIFT);
		await f.provider.execute(shift);
		expect((await f.router.status(f.targetRoute.planId))?.active).toBe(true);
		expect(f.router.select(f.targetRoute.planId, "request")?.endpoint).toBe(
			"https://target-service-abc.a.run.app/",
		);
		expect((await f.provider.observe(shift)).ready).toBe(true);
		const settled = await f.provider.observe(f.phase(Action.SETTLE));
		expect(settled).toMatchObject({
			ready: true,
			usageFinal: true,
			settledMicros: 0,
			destinationLiabilityFinalized: true,
		});
		expect(
			f.financialQueries.every(
				(query) =>
					query.providerId === "gcp" && query.providerAccountId === "account",
			),
		).toBe(true);
	});
	it("refuses a validly signed foreign billing account through the manifest alias before native effects", async () => {
		const f = await fixture("@hobo/provider-gcp", true);
		await expect(f.provider.execute(f.phase(Action.PREPARE))).rejects.toThrow(
			/scope/,
		);
		expect(f.writes()).toBe(0);
	});
});
