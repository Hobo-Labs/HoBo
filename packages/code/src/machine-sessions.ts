/**
 * Remote panes go through the Station, not straight to ssh.
 *
 * `hobo-code mux --host box` used to hand tmux a raw `ssh -t box <agent>`,
 * which works only because a long-lived key happens to sit in `~/.ssh`. That
 * key is ambient authority: it is not scoped to the agent, not time-bounded,
 * and its use leaves no trace in the Station's audit log even though every
 * other privileged path in HoBo is brokered.
 *
 * A pane now asks the Station's privileged-access gateway for a session
 * against a *declared* machine (see `dev-machines.ts`). The gateway applies the
 * target's isolation-class policy and writes `pam.SessionStarted` /
 * `pam.SessionDenied`. A pane the Station did not authorise is refused rather
 * than quietly falling back to the ambient key — a fallback that silently
 * downgrades governance is worse than a clear failure.
 *
 * The authorized Station session gates a lease-bound proxy to the user's
 * installed SSH agent. Private keys and session tokens never enter pane
 * commands, process arguments, or the remote machine.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import {
	createNativePamGateway,
	createPamAuditSink,
	createStationClient,
	railEnablesPam,
} from "@hobo/stations";

import type { DevMachine } from "./dev-machines.js";
import { pamTarget, sshDestination } from "./dev-machines.js";
import {
	type ResidentSshAgentProxy,
	type SshAgentProxy,
	startResidentSshAgentProxy,
	startSshAgentProxy,
} from "./ssh-agent-proxy.js";

/** The slice of `@hobo/stations`' gateway a pane actually needs. */
export interface PaneSessionBroker {
	registerTarget(target: {
		readonly id: string;
		readonly kind: "ssh";
		readonly isolationClass: string;
		readonly address: string;
	}): void;
	brokerSession(request: {
		readonly subject: string;
		readonly target: string;
		readonly preferSecretless: true;
		readonly ttlSeconds?: number;
		readonly reason?: string;
	}): Promise<{
		readonly sessionId: string;
		readonly expiresAt: string;
		readonly credentialRef: string;
		readonly protocol: string;
	}>;
}

export interface BrokeredPane {
	readonly machine: DevMachine;
	readonly agentId: string;
	readonly sessionId: string;
	readonly expiresAt: string;
	readonly credentialRef: string;
	readonly protocol: string;
	readonly destination: string;
}

export type ResolvedBrokeredPane = BrokeredPane & {
	readonly identityAgent: string;
};

export interface BrokerFailure {
	readonly machine: DevMachine;
	readonly agentId: string;
	readonly reason: string;
}

export type BrokerOutcome =
	| { readonly ok: true; readonly pane: BrokeredPane }
	| { readonly ok: false; readonly failure: BrokerFailure };

export interface BrokerOptions {
	readonly broker: PaneSessionBroker;
	readonly subject: string;
	/** Session lifetime; a pane that outlives it must renew, not linger. */
	readonly ttlSeconds?: number;
}

/**
 * Broker one pane's session.
 *
 * Registering the target every time is deliberate: the declared registry is
 * the source of truth for address and isolation class, and a gateway that
 * learned a stale address at start-up would broker against the wrong host.
 */
export async function brokerPaneSession(
	machine: DevMachine,
	agentId: string,
	options: BrokerOptions,
): Promise<BrokerOutcome> {
	const target = pamTarget(machine);
	try {
		options.broker.registerTarget(target);
		const handle = await options.broker.brokerSession({
			subject: options.subject,
			target: target.id,
			preferSecretless: true,
			...(options.ttlSeconds !== undefined
				? { ttlSeconds: options.ttlSeconds }
				: undefined),
			reason: `hobo-code pane for agent ${agentId}`,
		});
		return {
			ok: true,
			pane: {
				machine,
				agentId,
				sessionId: handle.sessionId,
				expiresAt: handle.expiresAt,
				credentialRef: handle.credentialRef,
				protocol: handle.protocol,
				destination: sshDestination(machine),
			},
		};
	} catch (error) {
		// A denial is an answer, not an error to paper over: the operator needs
		// to see which machine refused and why.
		return {
			ok: false,
			failure: {
				machine,
				agentId,
				reason: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

/**
 * The ssh invocation for a brokered pane.
 *
 * The local agent socket is passed, never the credential reference or session
 * token. The proxy exists only for the Station lease and forwards the SSH-agent
 * protocol to the installed user agent without copying private keys.
 */
export function brokeredSshCommand(
	pane: ResolvedBrokeredPane,
	command: string,
): string {
	const quote = (v: string) => `'${v.replace(/'/gu, `'\\''`)}'`;
	// -o selects the lease-bound local socket; no credential material reaches the
	// remote command or its process table.
	return [
		"ssh",
		"-t",
		"-o",
		quote(`IdentityAgent=${pane.identityAgent}`),
		quote(pane.destination),
		quote(command),
	].join(" ");
}

/** Human line for the mux panel — never includes session material. */
export function describePane(pane: BrokeredPane): string {
	return `${pane.agentId} · ${pane.machine.id} (${pane.machine.isolationClass}) · session ${pane.sessionId} until ${pane.expiresAt}`;
}

export interface StationBrokerContext {
	readonly hoboHome: string;
	readonly stationId: string;
	readonly isolationClass: DevMachine["isolationClass"];
	/** Override for tests; normal runs use the installed SSH_AUTH_SOCK. */
	readonly sshAuthSock?: string;
}

export interface ResolvedSshIdentity {
	readonly pane: ResolvedBrokeredPane;
	stop(): Promise<void>;
}

export interface OpenedGateway {
	readonly broker: PaneSessionBroker;
	/** Audit events produced so far — session refs only, never material. */
	auditTypes(): readonly string[];
	/** Number of facts durably appended to the Station's Yard audit feed. */
	yardDrainCount(): number;
	/** Process-local proxy, used while browser forwarding keeps this CLI alive. */
	resolveSshIdentity(pane: BrokeredPane): Promise<ResolvedSshIdentity>;
	/** Resident proxy, used by tmux after this launcher exits. */
	handoffSshIdentity(pane: BrokeredPane): Promise<ResolvedSshIdentity>;
	/**
	 * End every live authorization and persist its terminal audit facts. Each
	 * `pam.SessionEnded` says `reason`; without one, the gateway's stop says
	 * `gateway-stop`.
	 */
	close(reason?: string): Promise<void>;
}

/**
 * Start the Station's native gateway for the life of a mux invocation.
 *
 * Native rather than a remote control plane: a local Station is the normal
 * dogfooding case, and requiring Teleport/Boundary to be reachable before an
 * agent pane can open would push people straight back to the ambient key this
 * replaces.
 */
export async function openStationGateway(
	context: StationBrokerContext,
): Promise<OpenedGateway> {
	const station = createStationClient({
		hoboHome: context.hoboHome,
		stationId: context.stationId,
	});
	const occupancy = station.occupancy();
	if (occupancy.status !== "open") {
		throw new Error(`station ${context.stationId} is closed`);
	}
	const rail = station.activeRail();
	if (!railEnablesPam(rail.policyPacks, rail.metadata)) {
		throw new Error(
			`active Rail ${rail.id} does not enable privileged access for station ${context.stationId}`,
		);
	}
	const auditPath = join(station.dataDir, "pam-audit.jsonl");
	const auditSink = createPamAuditSink({
		yardAppend: (event) => {
			appendFileSync(auditPath, `${JSON.stringify(event)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
		},
	});
	const gateway = createNativePamGateway({
		isolationClass: context.isolationClass,
		auditSink,
	});
	await gateway.start({
		stationId: occupancy.stationId,
		tenant: occupancy.isolation.tenant,
		isolationClass: context.isolationClass,
		railId: rail.id,
		trustDomain: occupancy.isolation.trustDomain,
	});
	const upstreamSocket = context.sshAuthSock ?? process.env.SSH_AUTH_SOCK;
	const proxyPath = (sessionId: string): string => {
		if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) {
			throw new Error("PAM session id is not safe for a socket path");
		}
		return join(station.dataDir, "ssh-agent", `${sessionId}.sock`);
	};
	const auditEvent = async (
		pane: BrokeredPane,
		type: "pam.CredentialRedeemed" | "pam.SessionEnded",
		reason?: string,
	): Promise<void> => {
		await auditSink.append({
			type,
			time: new Date().toISOString(),
			stationId: occupancy.stationId,
			tenant: occupancy.isolation.tenant,
			sessionId: pane.sessionId,
			subject: "hobo-code",
			target: pamTarget(pane.machine).id,
			isolationClass: context.isolationClass,
			kind: "native",
			credentialRef: pane.credentialRef,
			...(reason ? { reason } : undefined),
		});
	};
	const requireUpstream = (): string => {
		if (!upstreamSocket) {
			throw new Error(
				"SSH_AUTH_SOCK is required for the Station-authorized agent",
			);
		}
		return upstreamSocket;
	};
	const localProxies = new Set<SshAgentProxy>();
	let stopped = false;
	let gatewayStopped = false;
	let closing: Promise<void> | undefined;
	return {
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		broker: gateway as PaneSessionBroker,
		auditTypes: () => gateway.auditEvents.map((e) => e.type),
		yardDrainCount: () => gateway.yardDrainCount,
		async resolveSshIdentity(pane) {
			const proxy = await startSshAgentProxy({
				socketPath: proxyPath(pane.sessionId),
				upstreamSocket: requireUpstream(),
				expiresAt: pane.expiresAt,
				onRedeem: () => auditEvent(pane, "pam.CredentialRedeemed"),
			});
			localProxies.add(proxy);
			return {
				pane: { ...pane, identityAgent: proxy.socketPath },
				async stop() {
					localProxies.delete(proxy);
					await proxy.close();
				},
			};
		},
		async handoffSshIdentity(pane) {
			gateway.handoffSession(pane.sessionId);
			let proxy: ResidentSshAgentProxy;
			try {
				proxy = await startResidentSshAgentProxy({
					socketPath: proxyPath(pane.sessionId),
					upstreamSocket: requireUpstream(),
					expiresAt: pane.expiresAt,
					auditPath,
					stationId: occupancy.stationId,
					tenant: occupancy.isolation.tenant,
					sessionId: pane.sessionId,
					subject: "hobo-code",
					target: pamTarget(pane.machine).id,
					isolationClass: context.isolationClass,
					credentialRef: pane.credentialRef,
				});
			} catch (error) {
				await auditEvent(pane, "pam.SessionEnded", "agent-proxy-start-failed");
				throw error;
			}
			return {
				pane: { ...pane, identityAgent: proxy.socketPath },
				stop: proxy.stop,
			};
		},
		// Every step is tried, and done only once it has succeeded: a close that
		// failed part way (an audit that could not be written) can be retried,
		// and the gateway's stop, with its pam.GatewayStopped, is always tried.
		async close(reason) {
			if (stopped) return;
			const inFlight = closing;
			if (inFlight !== undefined) return inFlight;
			const attempt = (async (): Promise<void> => {
				const failures: unknown[] = [];
				for (const proxy of localProxies) {
					try {
						await proxy.close();
						localProxies.delete(proxy);
					} catch (error) {
						failures.push(error);
					}
				}
				if (reason !== undefined) {
					for (const session of gateway.listSessions()) {
						try {
							await gateway.endSession(session.sessionId, reason);
						} catch (error) {
							failures.push(error);
						}
					}
				}
				if (!gatewayStopped) {
					try {
						await gateway.stop();
						gatewayStopped = true;
					} catch (error) {
						failures.push(error);
					}
				}
				// Done only once every step has succeeded: a proxy that would not
				// close stays in localProxies for the retry, and the gateway is
				// not stopped twice.
				if (failures.length === 0) stopped = true;
				if (failures.length > 0) {
					throw new AggregateError(
						failures,
						failures
							.map((failure) =>
								failure instanceof Error ? failure.message : String(failure),
							)
							.join("; "),
					);
				}
			})();
			closing = attempt.finally(() => {
				closing = undefined;
			});
			return closing;
		},
	};
}

/** Broker one session per pane, keeping failures alongside successes. */
export async function brokerPanes(
	placements: readonly { machine: DevMachine; agentId: string }[],
	options: BrokerOptions,
): Promise<{
	readonly panes: readonly BrokeredPane[];
	readonly failures: readonly BrokerFailure[];
}> {
	const panes: BrokeredPane[] = [];
	const failures: BrokerFailure[] = [];
	for (const { machine, agentId } of placements) {
		const outcome = await brokerPaneSession(machine, agentId, options);
		if (outcome.ok) panes.push(outcome.pane);
		else failures.push(outcome.failure);
	}
	return { panes, failures };
}
