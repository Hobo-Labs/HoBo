import {
	createUsageEvent,
	type MeteringBus,
	type OverlayNetwork,
	type PolicyEngine,
	type PublicDnsManager,
	parseTenantId,
	type TenantId,
} from "@hobo/core";
import {
	type EnrollmentRequest,
	type FleetTransport,
	type MemberRecord,
	type OverlayJoin,
	Role,
} from "@hobo/fleet";
import type { createFleetAgent } from "@hobo/fleet/agent";
import {
	createJunctionDynamicDnsRegistrar,
	type DynamicDnsTarget,
	type JunctionDynamicDnsRegistrar,
} from "./dns/dynamic-registrar.js";
import {
	type IsolationClass,
	isolationClassTag,
	parseIsolationClass,
} from "./env-isolation/types.js";
import { isJsonString } from "./json.js";
import { createOverlayTransport } from "./overlay-transport.js";

export type JunctionAgentRole = "junction" | "broker";

export interface JunctionAgentConfig {
	readonly tenantId: TenantId | string;
	readonly name: string;
	readonly role?: JunctionAgentRole;
	/** Isolation class / env — fixed at start; change only via control-plane. */
	readonly env?: string;
	readonly cloud?: string;
	/** Hard isolation: stamp onto overlay tags. */
	readonly overlayNetworkId?: string;
	/** Targets to advertise via dynamic DNS on each heartbeat. */
	readonly dnsTargets?: readonly DynamicDnsTarget[];
	/**
	 * Peer junction isolation class for federation checks.
	 * Cross-env federation denied unless explicit grant presented to PolicyEngine.
	 */
	readonly federationPeerEnv?: string;
}

export type JunctionFleetAgent = ReturnType<typeof createFleetAgent>;

export type JunctionFleet = Readonly<{
	agent: (transports: readonly FleetTransport[]) => JunctionFleetAgent;
	enrollment?: Omit<EnrollmentRequest, "identityJwk" | "keyBundle">;
}>;

export type JunctionAgentStart = Readonly<{
	ready: boolean;
	notes: readonly string[];
	overlayIps: readonly string[];
}>;

export interface JunctionAgent {
	readonly config: JunctionAgentConfig;
	readonly dynamicDns: JunctionDynamicDnsRegistrar | null;
	start(): Promise<JunctionAgentStart>;
	stop(): Promise<void>;
	heartbeat(): Promise<{
		readonly dns?: {
			readonly registered: number;
			readonly skipped: number;
		};
	}>;
	status(): Promise<{
		readonly running: boolean;
		readonly overlayIps: readonly string[];
		readonly member: MemberRecord | undefined;
	}>;
}

function joinFor(
	joins: readonly OverlayJoin[],
	provider: string,
	nowMs: number,
): OverlayJoin | undefined {
	return joins.find((join) => {
		const expires = Date.parse(join.expiresAt);
		return (
			join.provider === provider &&
			join.credential.length > 0 &&
			(Number.isNaN(expires) || expires > nowMs)
		);
	});
}

function withJunctionRole(
	request: Omit<EnrollmentRequest, "identityJwk" | "keyBundle">,
): Omit<EnrollmentRequest, "identityJwk" | "keyBundle"> {
	return request.requestedRoles.includes(Role.JUNCTION)
		? request
		: {
				...request,
				requestedRoles: [...request.requestedRoles, Role.JUNCTION],
			};
}

const notReady = (notes: readonly string[]): JunctionAgentStart => ({
	ready: false,
	notes,
	overlayIps: [],
});

export function createJunctionAgent(options: {
	readonly config: JunctionAgentConfig;
	readonly overlay: OverlayNetwork;
	readonly fleet: JunctionFleet;
	readonly policy?: PolicyEngine;
	readonly metering?: MeteringBus;
	readonly publicDns?: PublicDnsManager;
	readonly emitProgress?: (message: string) => void;
	readonly now?: () => number;
}): JunctionAgent {
	const tenantId = isJsonString(options.config.tenantId)
		? parseTenantId(options.config.tenantId)
		: options.config.tenantId;
	const role = options.config.role ?? "junction";
	const now = options.now ?? Date.now;
	let running = false;
	let overlayIps: string[] = [];
	let device: JunctionFleetAgent | undefined;

	const dynamicDns =
		options.publicDns !== undefined
			? createJunctionDynamicDnsRegistrar({
					tenantId,
					dns: options.publicDns,
					overlay: options.overlay,
					...(options.policy !== undefined
						? { policy: options.policy }
						: undefined),
					...(options.metering !== undefined
						? { metering: options.metering }
						: undefined),
					...(options.emitProgress !== undefined
						? { emitProgress: options.emitProgress }
						: undefined),
				})
			: null;

	if (dynamicDns && options.config.dnsTargets) {
		dynamicDns.setTargets(options.config.dnsTargets);
	}

	const enroll = async (): Promise<
		Readonly<{ ok: true; joins: readonly OverlayJoin[] }> | JunctionAgentStart
	> => {
		const request = options.fleet.enrollment;
		if (request === undefined) return { ok: true, joins: [] };
		const enrolled = await options.fleet
			.agent([])
			.enroll(withJunctionRole(request));
		if (!enrolled.ok)
			return notReady([
				`junction fleet enrollment failed (${enrolled.error.code}): ${enrolled.error.message}`,
			]);
		return { ok: true, joins: enrolled.value.overlayJoins };
	};

	return {
		config: { ...options.config, tenantId },
		dynamicDns,
		async start() {
			const isolationClass: IsolationClass | null = parseIsolationClass(
				options.config.env,
			);
			// Fail closed: Junction agents require an env / isolation class.
			if (!isolationClass) {
				return notReady([
					"junction env isolation class required (fail closed) — set config.env",
				]);
			}
			const envTag = isolationClassTag(isolationClass);
			const tags = [
				...options.overlay.tenantTags({
					tenantId,
					role,
					env: isolationClass,
					...(options.config.cloud !== undefined
						? { cloud: options.config.cloud }
						: undefined),
					...(options.config.overlayNetworkId !== undefined
						? { overlayNetworkId: options.config.overlayNetworkId }
						: undefined),
				}),
				envTag,
			];

			// Cross-env federation denied by default (peer env must match).
			if (options.config.federationPeerEnv !== undefined) {
				const peer = parseIsolationClass(options.config.federationPeerEnv);
				if (peer !== isolationClass) {
					return notReady([
						`junction env-scoped federation denied: ${isolationClass} cannot federate ${peer ?? "unknown"} without dual-controlled CrossEnvGrant`,
					]);
				}
			}

			if (options.policy) {
				const decision = await options.policy.evaluate({
					subject: {
						identity: options.config.name,
						tenantId,
						tags,
					},
					action: "junction.join",
					resource: {
						kind: "junction",
						id: options.config.name,
						tenantId,
						tags: [envTag],
					},
				});
				if (decision.effect === "deny") return notReady(decision.reasons);
			}

			const enrolled = await enroll();
			if (!("ok" in enrolled)) return enrolled;
			const credential = joinFor(
				enrolled.joins,
				options.overlay.provider,
				now(),
			);

			const join = await options.overlay.join({
				tenantId,
				hostname: options.config.name,
				tags,
				...(credential !== undefined
					? { authKey: credential.credential }
					: undefined),
				...(options.emitProgress !== undefined
					? { emitProgress: options.emitProgress }
					: undefined),
			});
			running = join.ready || join.identity.nodeId.startsWith("stub:");
			overlayIps = [...join.identity.overlayIps];
			const notes = [...join.notes];

			if (join.ready) {
				device = options.fleet.agent([createOverlayTransport(options.overlay)]);
				try {
					await device.start();
				} catch (error) {
					notes.push(
						`junction fleet agent did not start: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			// Configure MagicDNS split for hierarchical .hobo.test names when ready.
			if (join.ready && options.overlay.configureMagicDns) {
				const magic = await options.overlay.configureMagicDns({
					tenantId,
					domains: ["hobo.test", "hobo.internal"],
					nameservers: ["100.100.100.100"],
				});
				options.emitProgress?.(
					`hobo overlay magicdns: applied=${magic.applied} domains=${magic.domains.join(",")}`,
				);
			}

			await options.metering?.emit(
				createUsageEvent({
					tenantId,
					eventType: "junction.join",
					resource: options.config.name,
					metadata: {
						provider: join.provider,
						ready: join.ready,
						role,
					},
				}),
			);
			if (join.ready) {
				await options.metering?.emit(
					createUsageEvent({
						tenantId,
						eventType: "tunnel.up",
						resource: options.config.name,
						metadata: { provider: join.provider },
					}),
				);
			}
			return {
				ready: join.ready,
				notes,
				overlayIps,
			};
		},
		async stop() {
			const stopping = device;
			device = undefined;
			await stopping?.stop();
			if (running) {
				await options.metering?.emit(
					createUsageEvent({
						tenantId,
						eventType: "tunnel.down",
						resource: options.config.name,
					}),
				);
				await options.metering?.emit(
					createUsageEvent({
						tenantId,
						eventType: "junction.leave",
						resource: options.config.name,
					}),
				);
			}
			await options.overlay.leave();
			running = false;
			overlayIps = [];
		},
		async heartbeat() {
			if (!running) return {};
			await options.metering?.emit(
				createUsageEvent({
					tenantId,
					eventType: "tunnel.heartbeat",
					resource: options.config.name,
					unit: "tick",
				}),
			);
			if (dynamicDns) {
				const dns = await dynamicDns.onHeartbeat();
				return {
					dns: {
						registered: dns.registered,
						skipped: dns.skipped,
					},
				};
			}
			return {};
		},
		async status() {
			return { running, overlayIps, member: device?.status().member };
		},
	};
}
