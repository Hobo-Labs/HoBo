import type { StrictFleetStore } from "@hobo/ci/fleet-v2";
import type { ControlAuthenticator } from "./control-auth.js";
import {
	createStartFenceHandler,
	type StartFencePolicy,
} from "./fleet-v2/start-fence-handler.js";
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
import {
	createRelayHandler,
	type HostedRelayApplication,
	type StubEngine,
	type VerifiedWebhook,
} from "./http-handler.js";
import type { MeshNodesReader } from "./mesh-nodes-reader.js";
import type { IdentityVerifier } from "./oidc.js";
import { createRelayMcp, isRelayMcpPath } from "./relay-mcp.js";
import type { RelayMcpStore } from "./relay-mcp-server.js";
import {
	admitWhenReady,
	createRelayService,
	type RelayServiceLog,
} from "./service.js";

export type RelayAgent = Readonly<{
	tick(): Promise<void>;
	intervalMs?: number;
}>;

export type RelayHostWiring = Readonly<{
	onWebhook(webhook: VerifiedWebhook): void;
	page(request: Request): Promise<Response | undefined>;
	control(request: Request): Promise<Response | undefined>;
}>;

export function createRelayHost(options: {
	store: HostedInboxStore &
		HostedControlStore &
		RelayMcpStore & { close(): void };
	mcpStore?: RelayMcpStore;
	github: GithubAppTransport;
	strictFleet?:
		| {
				store: StrictFleetStore;
				policies: readonly StartFencePolicy[];
		  }
		| undefined;
	identity: IdentityVerifier;
	webhookSecret: string;
	ingressForwardSecret?: string | undefined;
	authenticate: ControlAuthenticator;
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
	agent?: RelayAgent | undefined;
	meshNodes?: MeshNodesReader | undefined;
	logger?: (entry: RelayServiceLog) => void;
	now?: () => string;
	wiring?: RelayHostWiring | undefined;
}) {
	const { store, github, identity, webhookSecret } = options;
	const startFence = options.strictFleet
		? createStartFenceHandler({ ...options.strictFleet, github })
		: undefined;
	const now = options.now ?? (() => new Date().toISOString());
	const log = (entry: RelayServiceLog) => {
		try {
			options.logger?.(entry);
		} catch {
		}
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
		control: async (request) => {
			const startResponse = await startFence?.(request);
			if (startResponse) return startResponse;
			return createHostedControlPlane({
				relay: await relay(),
				store,
				github,
				authenticate: options.authenticate,
				publicOrigin: options.publicOrigin,
				assets: options.assets,
				fullAccountUpdates: true,
				meshNodes: options.meshNodes,
			})(request);
		},
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
	const { wiring } = options;
	const application: HostedRelayApplication = wiring
		? {
				...runtime,
				mcp: mcp.handle,
				async ingestWebhook(input) {
					const status = await runtime.ingestWebhook(input);
					wiring.onWebhook(input);
					return status;
				},
				page: (request) => wiring.page(request),
				async control(request) {
					return (await wiring.control(request)) ?? runtime.control(request);
				},
			}
		: { ...runtime, mcp: mcp.handle };
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
				application: admitWhenReady(application, ready),
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
		readinessProbe: async (signal) => {
			signal.throwIfAborted();
			return runtime.ready();
		},
		logger: log,
	});
	return { service, runtime };
}
