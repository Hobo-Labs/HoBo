import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ManifestV1, parseManifest } from "@hobo/bindles";

import type { EventEnvelope } from "@hobo/core";
import { createInMemoryActorHost } from "@hobo/data";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	collectStream,
	createInProcessCredentialBroker,
	createInProcessExecutor,
	createRegistryFromProviders,
	credentialAuditProjection,
	credentialScope,
	type DeploymentPlan,
	deploy,
	deploymentStreamId,
	deploymentViewProjection,
	type Executor,
	type GatewayDeps,
	hashDeploymentPlan,
	type IacProvider,
	lowerManifest,
	matchResource,
	type OrchestratorDeps,
	plan,
	type ResourceIntent,
	runOrchestrator,
} from "../../src/index.js";

// Consumer contracts (control-plane.md service boundaries): the Yard kernel is
// the ControlPlaneReferenceApp consumer of the lifted epic pacts. Each test
// verifies our side honors the documented boundary schema.

const packageRoot = dirname(fileURLToPath(import.meta.url));
function loadPact(name: string) {
	return JSON.parse(readFileSync(join(packageRoot, "../pacts/", name), "utf8"));
}

const fixturesDir = join(packageRoot, "../../test/fixtures");
function helloBindle(): ManifestV1 {
	return parseManifest(
		JSON.parse(
			readFileSync(join(fixturesDir, "hello-bindle.manifest.json"), "utf8"),
		),
	);
}
function registry() {
	return createRegistryFromProviders([createCloudflareProvider()]);
}
function loadPlan(): DeploymentPlan {
	// SAFETY: `return JSON.parse(` is required at this I/O or test boundary.
	return JSON.parse(
		readFileSync(join(fixturesDir, "multi-cloud-shop-plan.json"), "utf8"),
	) as DeploymentPlan;
}
function mockIac(opts: { failApply?: string[] } = {}): IacProvider {
	const fail = new Set(opts.failApply ?? []);
	return {
		id: "mock-local-container",
		async preview(p) {
			return { summary: `preview ${p.resourceId}`, changes: 1 };
		},
		async apply(p) {
			if (fail.has(p.resourceId))
				throw new Error(`apply failed for ${p.resourceId}`);
			return { endpoint: `${p.resourceId}.local` };
		},
		async destroy() {},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
}
function orchestratorDeps(
	store: RuntimeLocalEventStore,
	executor: Executor,
): OrchestratorDeps {
	return {
		store,
		actorHost: createInMemoryActorHost(),
		executor,
		broker: createInProcessCredentialBroker(),
	};
}

let stores: RuntimeLocalEventStore[] = [];
function freshStore(): RuntimeLocalEventStore {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cloud-pact-"));
	const s = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	stores.push(s);
	return s;
}
afterEach(() => {
	for (const s of stores) s.close();
	stores = [];
});
const actor = { kind: "user", id: "operator-1" } as const;
function deps(store: RuntimeLocalEventStore): GatewayDeps {
	return { store, actorHost: createInMemoryActorHost(), registry: registry() };
}

describe("ManifestIrCollector boundary (consumer contract)", () => {
	it("collects manifest resources + bind-edge links (step 0/1 lowering)", () => {
		const pact = loadPact("manifest-ir-collector.pact.json");
		expect(pact.provider.name).toBe("ManifestIrCollector");
		const body = pact.interactions[0].response.body;

		const intents = lowerManifest(helloBindle());
		const resources = intents.map((i) => i.name);
		const links = intents.flatMap((i) => i.deps.map((dep) => [dep, i.name]));

		// Same shape the boundary documents: a resource list + directed links.
		expect(Object.keys(body).sort()).toEqual(["links", "resources"]);
		expect(resources.length).toBeGreaterThan(0);
		expect(resources).toEqual(["assets", "service", "sessions"]);
		expect(links).toContainEqual(["assets", "service"]);
	});
});

describe("ResourceDefinitionCatalog boundary (consumer contract)", () => {
	it("returns a stable catalog snapshot + a matching winner", () => {
		const pact = loadPact("resource-definition-catalog.pact.json");
		expect(pact.provider.name).toBe("ResourceDefinitionCatalog");
		const body = pact.interactions[0].response.body;
		expect(Object.keys(body).sort()).toEqual([
			"candidates",
			"catalogHash",
			"winner",
		]);

		const reg = registry();
		const intent: ResourceIntent = {
			name: "service",
			port: "compute",
			require: ["http"],
			prefer: [],
			negotiation: "require",
			deps: [],
			objective: "min-cost",
		};
		const outcome = matchResource(intent, reg);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.decision.catalogHash).toBe(reg.catalogHash);
		expect(outcome.decision.winner).toBe("@hobo/provider-cloudflare.compute");
	});
});

describe("CapabilityRegistry boundary (consumer contract)", () => {
	it("rejects an unsatisfiable require with a remediation code", () => {
		const pact = loadPact("capability-registry.pact.json");
		expect(pact.provider.name).toBe("CapabilityRegistry");
		const body = pact.interactions[0].response.body;
		expect(body.decision).toBe("reject");

		const intent: ResourceIntent = {
			name: "checkout-api",
			port: "compute",
			require: ["gpu"],
			prefer: [],
			negotiation: "require",
			deps: [],
			objective: "min-cost",
		};
		const outcome = matchResource(intent, registry());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.remediation.code).toBe(body.code);
		expect(outcome.remediation.remediation).toContain("prefer");
	});
});

describe("EventStoreActorHost boundary (consumer contract)", () => {
	it("appends control-plane facts under a single-writer lease", async () => {
		const pact = loadPact("eventstore-actorhost.pact.json");
		expect(pact.provider.name).toBe("EventStoreActorHost");
		expect(pact.interactions[0].response.body.lease).toBe("single-writer");

		const store = freshStore();
		const result = await deploy(
			deps(store),
			{ deploymentId: "cp-1", bindle: helloBindle() },
			{ tenant: "t", actor },
		);
		expect(result.status).toBe("planned");

		const events: EventEnvelope[] = [];
		for await (const e of store.read(deploymentStreamId("cp-1")))
			events.push(e);
		expect(events[0]?.type).toBe("deployment.Requested");
		// Per-stream monotonic seq is the single-writer guarantee.
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
	});
});

describe("DeploymentSetStore boundary (consumer contract)", () => {
	it("content-addresses the plan as an immutable set ref", () => {
		const pact = loadPact("deployment-set-store.pact.json");
		expect(pact.provider.name).toBe("DeploymentSetStore");
		expect(pact.interactions[0].response.body.appliedSetRef).toMatch(
			/^set:.*@sha256:/,
		);

		const result = plan(helloBindle(), { deploymentId: "cp-1" }, registry());
		if (!result.ok) throw new Error("expected plan");
		const setRef = `set:cp-1@${hashDeploymentPlan(result.plan)}`;
		expect(setRef).toMatch(/^set:cp-1@sha256:[a-f0-9]{64}$/);
	});
});

describe("DeploymentViewProjection boundary (consumer contract)", () => {
	it("reconstructs the deployment graph from the log", async () => {
		const pact = loadPact("deployment-view-projection.pact.json");
		expect(pact.provider.name).toBe("DeploymentViewProjection");
		const body = pact.interactions[0].response.body;
		expect(body.correlationComplete).toBe(true);

		const store = freshStore();
		await deploy(
			deps(store),
			{ deploymentId: "cp-2", bindle: helloBindle() },
			{ tenant: "t", actor, correlationId: "deploy:cp-2" },
		);
		const view = await deploymentViewProjection.rebuildFromZero(
			store,
			deploymentStreamId("cp-2"),
		);
		const row = deploymentViewProjection.get(view, "cp-2");
		// Graph reconstructed: requested -> decided(xN) -> planned, no gaps.
		expect(row?.status).toBe("planned");
		expect(row?.decisions.length).toBe(3);
		expect(body.missingEvents).toEqual([]);
	});
});

describe("DeploymentSagaOrchestrator boundary (consumer contract)", () => {
	it("choreographs the plan DAG to deployment.Deployed", async () => {
		const pact = loadPact("deployment-saga-orchestrator.pact.json");
		expect(pact.provider.name).toBe("DeploymentSagaOrchestrator");
		const body = pact.interactions[0].response.body;

		const store = freshStore();
		const result = await runOrchestrator(
			orchestratorDeps(store, createInProcessExecutor({ iac: mockIac() })),
			loadPlan(),
			"shop-1",
			{ tenant: "t", actor },
		);
		expect(result.status).toBe(body.status);
		expect(result.provisioned).toEqual(body.provisioned);
		const events: EventEnvelope[] = [];
		for await (const e of store.read(deploymentStreamId("shop-1")))
			events.push(e);
		expect(events.at(-1)?.type).toBe(body.terminalEvent);
	});

	it("compensates a no-go failure in reverse-dependency order", async () => {
		const pact = loadPact("deployment-saga-orchestrator.pact.json");
		const body = pact.interactions[2].response.body;

		const store = freshStore();
		const result = await runOrchestrator(
			orchestratorDeps(
				store,
				createInProcessExecutor({ iac: mockIac({ failApply: ["web"] }) }),
			),
			loadPlan(),
			"shop-rollback",
			{ tenant: "t", actor, noGoThresholdResources: new Set(["web"]) },
		);
		expect(result.status).toBe(body.status);
		expect(result.compensation?.destroyedOrder).toEqual(body.destroyedOrder);
	});
});

describe("CredentialAuditProjection boundary (consumer contract)", () => {
	const CORRELATION = "run:run-hello-bindle-j2-1:credentials";
	const CRED_STREAM = "credential-audit/run-hello-bindle-j2-1";
	const svcActor = { kind: "service", id: "yard/token-broker" } as const;

	it("replays a brokered-deploy credential trail with no static secrets", async () => {
		const pact = loadPact("credential-audit-retention.pact.json");
		expect(pact.provider.name).toBe("hobo-credential-audit-projection");
		const body = pact.interactions[0].response.body;

		const store = freshStore();
		await store.append(
			CRED_STREAM,
			[
				{
					type: "token.Granted",
					data: {
						grantId: "grant-cf-deploy",
						svidSubject: "spiffe://yard/tenant-a/agent/deployer",
						tokenRef: "tokenref://broker/grant/grant-cf-deploy",
						scope: {
							port: "compute",
							resource: "hello-bindle",
							action: "deploy",
						},
					},
				},
				{
					type: "token.Used",
					data: {
						grantId: "grant-cf-deploy",
						svidSubject: "spiffe://yard/tenant-a/agent/deployer",
					},
				},
			],
			{
				expectedSeq: 0,
				actor: svcActor,
				tenant: "tenant-a",
				correlationId: CORRELATION,
			},
		);

		// Replayable: rebuild-from-zero reconstructs the grant/use trail from the log.
		const rebuilt = await credentialAuditProjection.rebuildFromZero(
			store,
			CRED_STREAM,
		);
		const row = credentialAuditProjection.get(rebuilt, CORRELATION);
		expect(row).toBeDefined();
		expect(row?.timeline.map((e) => e.type)).toEqual(body.tokenTrail);

		// No static secrets found: the audit surface carries only references.
		const events = await collectStream(store, CRED_STREAM);
		const surface = JSON.stringify({ row, events });
		expect(surface.includes("hobotok_")).toBe(false);
		expect(surface.includes("providertok_")).toBe(false);
		expect(body.replayable).toBe(true);
		expect(body.staticSecretsFound).toBe(false);
	});
});

describe("ExecutorSandbox boundary (consumer contract)", () => {
	it("runs a scoped apply with no ambient credentials", async () => {
		const pact = loadPact("executor-sandbox.pact.json");
		expect(pact.provider.name).toBe("ExecutorSandbox");
		const body = pact.interactions[0].response.body;

		const broker = createInProcessCredentialBroker();
		const executor = createInProcessExecutor({ iac: mockIac() });
		const result = await executor.run(
			{
				programId: "deploy-1:api",
				deploymentId: "deploy-1",
				resourceId: "api",
				provider: "@hobo/provider-local",
				driver: "pulumi",
				action: "apply",
				stackName: "tenant-a/deploy-1/api",
			},
			broker.issue({
				scope: credentialScope({
					tenant: "tenant-a",
					resourceId: "api",
					driver: "pulumi",
					action: "apply",
				}),
			}),
		);
		expect(result.status).toBe(body.status);
		expect(result.sandbox.ambientCredentials).toBe(body.ambientCredentials);
		expect(result.events.map((e) => e.type)).toEqual(body.events);
	});

	it("refuses fatally when ambient cloud credentials are present", async () => {
		const pact = loadPact("executor-sandbox.pact.json");
		const body = pact.interactions[1].response.body;

		const broker = createInProcessCredentialBroker();
		const executor = createInProcessExecutor({ iac: mockIac() });
		const result = await executor.run(
			{
				programId: "deploy-1:api",
				deploymentId: "deploy-1",
				resourceId: "api",
				provider: "@hobo/provider-local",
				driver: "pulumi",
				action: "apply",
				stackName: "tenant-a/deploy-1/api",
			},
			broker.issue({
				scope: credentialScope({
					tenant: "tenant-a",
					resourceId: "api",
					driver: "pulumi",
					action: "apply",
				}),
			}),
			{ ambientEnv: { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE" } },
		);
		expect(result.status).toBe(body.status);
		if (result.status !== "failed") return;
		expect(result.classification).toBe(body.classification);
		expect(result.reason).toContain(body.reason);
	});
});
