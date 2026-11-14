import type { ControlAuthenticator } from "./control-auth.js";
import {
	createMemoryFleetVerdicts,
	FLEET_VERDICT_DAILY_BLOCK_MINUTES,
	type FleetReporter,
} from "./fleet-verdict.js";
import type { GithubAppTransport } from "./github.js";
import {
	createHostedControlPlane,
	type HostedControlStore,
} from "./hosted-control.js";
import { HostedRelay } from "./hosted-relay.js";
import {
	createHostedRelayRuntime,
	type HostedInboxStore,
} from "./hosted-runtime.js";
import { createRelayHandler, type StubEngine } from "./http-handler.js";
import type { MeshNodesReader } from "./mesh-nodes-reader.js";
import type { IdentityVerifier } from "./oidc.js";
import { createRelayMcp, isRelayMcpPath } from "./relay-mcp.js";
import type { RelayMcpStore } from "./relay-mcp-server.js";
import {
	admitWhenReady,
	createRelayService,
	type RelayServiceLog,
} from "./service.js";
import type { GithubWorkflowVerifier } from "./workflow-oidc.js";

/**
 * An optional CI agent beside the relay (see `@hobo/ci-agent`). The relay
 * only schedules it; what a pass does is the agent's own business.
 */
export type RelayAgent = Readonly<{
	tick(): Promise<void>;
	/** How often a pass starts; one minute when omitted. */
	intervalMs?: number;
}>;

/**
 * The relay as a long-running Node service over one store partition: the host
 * behind `hobo ci serve` and the container image. It composes the same relay
 * core, control plane and HTTP handler as every other host, and adds the
 * listener, the tick timer, the readiness probe and the drain.
 */
export function createRelayHost(options: {
	store: HostedInboxStore &
		HostedControlStore &
		RelayMcpStore & { close(): void };
	/**
	 * What the MCP server reads through, when the store's own reads take a
	 * lock that admission also takes: that store's observer. Defaults to the
	 * store itself, which is right for a single-writer SQLite file.
	 */
	mcpStore?: RelayMcpStore;
	github: GithubAppTransport;
	identity: IdentityVerifier;
	webhookSecret: string;
	ingressForwardSecret?: string | undefined;
	authenticate: ControlAuthenticator;
	/** The public origin; an `http:` one must be explicitly allowed loopback. */
	publicOrigin: string;
	allowLoopbackHttp?: boolean;
	assets: { workflow: string; bootstrap: string };
	host?: string;
	port: number;
	stubEngines?: Readonly<Record<string, StubEngine>>;
	trustProxy?: boolean;
	tickIntervalMs?: number;
	probeIntervalMs?: number;
	probeTimeoutMs?: number;
	drainTimeoutMs?: number;
	/** Off unless supplied. It never delays the worker tick or fails the relay. */
	agent?: RelayAgent | undefined;
	/**
	 * What the relay mesh looks like from this host, when it is a node of one
	 * (`createMeshNode`). The account API's `GET /v1/mesh/nodes` and the MCP
	 * server's `list_mesh_nodes` both answer from it; without it both answer
	 * `mesh: "not-configured"`.
	 */
	meshNodes?: MeshNodesReader | undefined;
	/**
	 * The fleet reporters whose signed reports this host accepts (ADR-0180).
	 * None unless supplied: every report is then refused and every label is
	 * served open.
	 */
	fleetReporters?: readonly FleetReporter[] | undefined;
	/** Verifies a workflow's OIDC token for the fleet reporter status route. */
	workflowIdentity?: GithubWorkflowVerifier | undefined;
	logger?: (entry: RelayServiceLog) => void;
	now?: () => string;
}) {
	const { store, github, identity, webhookSecret } = options;
	const now = options.now ?? (() => new Date().toISOString());
	const log = (entry: RelayServiceLog) => {
		try {
			options.logger?.(entry);
		} catch {
			// A failed logger must not fail a tick or a request.
		}
	};
	// Kept in this process: a verdict lapses in minutes and its reporter
	// repeats it, so a restart costs one report (ADR-0180).
	const fleetVerdicts = {
		store: createMemoryFleetVerdicts(() => Date.parse(now())),
		settings: () => ({
			reporters: options.fleetReporters ?? [],
			serving: true,
			dailyBlockMinutes: FLEET_VERDICT_DAILY_BLOCK_MINUTES,
		}),
		workflowIdentity: options.workflowIdentity,
	};
	const relay = async () => {
		const state = await store.configuration();
		if (!state?.configuration)
			throw new Error("configuration snapshot missing");
		return new HostedRelay({
			config: state.configuration,
			store,
			github,
			identity,
			webhookSecret,
			now,
		});
	};
	const runtime = createHostedRelayRuntime({
		store,
		github,
		identity,
		webhookSecret,
		control: async (request) =>
			createHostedControlPlane({
				relay: await relay(),
				store,
				github,
				authenticate: options.authenticate,
				publicOrigin: options.publicOrigin,
				assets: options.assets,
				// This host's operator owns its provider inventory.
				fullAccountUpdates: true,
				meshNodes: options.meshNodes,
				fleetVerdicts,
			})(request),
		onLeaseFailure: (leaseId) =>
			log({ level: "error", event: "worker.lease_failed", leaseId }),
		now,
	});
	const { agent } = options;
	const agentOptions = agent
		? {
				agentTick: () => agent.tick(),
				agentIntervalMs: agent.intervalMs ?? 60_000,
			}
		: {};
	// This process outlives a request, so it holds MCP sessions and pushes
	// resource updates to their subscribers.
	const mcp = createRelayMcp({
		store: options.mcpStore ?? store,
		relay,
		authenticate: options.authenticate,
		ready: async () => service.ready(),
		meshNodes: options.meshNodes,
		publicOrigin: options.publicOrigin,
		sessions: "memory",
		cursorSecret: webhookSecret,
	});
	const service = createRelayService({
		origin: options.publicOrigin,
		allowLoopbackHttp: options.allowLoopbackHttp === true,
		host: options.host ?? "127.0.0.1",
		port: options.port,
		tickIntervalMs: options.tickIntervalMs ?? 5_000,
		probeIntervalMs: options.probeIntervalMs ?? 60_000,
		probeTimeoutMs: options.probeTimeoutMs ?? 5_000,
		drainTimeoutMs: options.drainTimeoutMs ?? 30_000,
		handle: (ready) =>
			createRelayHandler({
				application: admitWhenReady({ ...runtime, mcp: mcp.handle }, ready),
				webhookSecret,
				ingressForwardSecret: options.ingressForwardSecret,
				engineId: "gh-actions",
				stubEngines: options.stubEngines ?? {},
				trustProxy: options.trustProxy === true,
				now,
			}),
		tick: () => runtime.tick(),
		...agentOptions,
		close: () => store.close(),
		streams: isRelayMcpPath,
		quiesce: () => mcp.close(),
		// Deployment readiness is local partition integrity. A real runner acceptance
		// workflow separately verifies external installation permissions and execution.
		readinessProbe: async (signal) => {
			signal.throwIfAborted();
			return runtime.ready();
		},
		logger: log,
	});
	return { service, runtime };
}
