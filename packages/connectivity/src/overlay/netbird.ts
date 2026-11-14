import {
	createUsageEvent,
	type FunnelPublishOptions,
	type FunnelPublishResult,
	type MagicDnsSplitConfig,
	type MagicDnsSplitResult,
	type MeteringBus,
	type OverlayJoinOptions,
	type OverlayJoinResult,
	type OverlayNetwork,
} from "@hobo/core";

import {
	createNetbirdApiClient,
	type NetbirdApiClient,
} from "./netbird-api.js";

/**
 * Netbird overlay adapter — management API for enrollment, peers, and DNS.
 * Ready when management URL + the join's setup key and/or access token (DNS
 * admin). The setup key is only ever `OverlayJoinOptions.authKey`: the
 * one-off key the HoBo Fleet authority minted at enrollment (ADR-0182). There
 * is no static setup key and none is read from the environment.
 */
export function createNetbirdOverlay(options?: {
	readonly metering?: MeteringBus;
	readonly managementUrl?: string;
	readonly accessToken?: string;
	readonly fetchImpl?: typeof fetch;
	readonly api?: NetbirdApiClient;
}): OverlayNetwork {
	let current: OverlayJoinResult["identity"] | null = null;
	const managementUrl =
		options?.managementUrl ??
		process.env.NETBIRD_MANAGEMENT_URL ??
		process.env.HOBO_NETBIRD_URL;

	function client(): NetbirdApiClient | null {
		if (options?.api) return options.api;
		if (!managementUrl) return null;
		const accessToken = options?.accessToken ?? process.env.NETBIRD_TOKEN;
		return createNetbirdApiClient({
			managementUrl,
			...(accessToken !== undefined && accessToken.length > 0
				? { accessToken }
				: undefined),
			...(options?.fetchImpl !== undefined
				? { fetchImpl: options.fetchImpl }
				: undefined),
		});
	}

	return {
		provider: "netbird",
		tenantTags({ tenantId, role, env, cloud, overlayNetworkId }) {
			const tags = [`tenant:${tenantId}`, `role:${role}`];
			if (env) tags.push(`env:${env}`);
			if (cloud) tags.push(`cloud:${cloud}`);
			if (overlayNetworkId) tags.push(`overlay:${overlayNetworkId}`);
			return tags;
		},
		async join(join: OverlayJoinOptions): Promise<OverlayJoinResult> {
			const tags = [...join.tags];
			if (!tags.some((t) => t.startsWith("tenant:"))) {
				tags.push(`tenant:${join.tenantId}`);
			}
			const api = client();
			const notes: string[] = [];
			let ready = false;
			let overlayIps: string[] = [];
			let nodeId = `netbird:${join.hostname}`;

			if (api) {
				const enrolled = await api.enrollPeer({
					name: join.hostname,
					...(join.authKey ? { setupKey: join.authKey } : undefined),
				});
				notes.push(...enrolled.notes);
				if (enrolled.peer) {
					nodeId = enrolled.peer.id;
					if (enrolled.peer.ip) overlayIps = [enrolled.peer.ip];
				}
				// ready requires concrete peer identity (id and/or ip), not mere key validation.
				if (enrolled.enrolled && !enrolled.peer?.id && !enrolled.peer?.ip) {
					try {
						const peers = await api.listPeers();
						const hit = peers.find(
							(p) => p.name === join.hostname || p.id === join.hostname,
						);
						if (hit) {
							nodeId = hit.id;
							if (hit.ip) overlayIps = [hit.ip];
						}
					} catch (error) {
						notes.push(
							`list peers: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				ready =
					Boolean(enrolled.peer?.id || enrolled.peer?.ip) ||
					(overlayIps.length > 0 && nodeId !== `netbird:${join.hostname}`);
				if (enrolled.enrolled && !ready) {
					notes.push(
						"setup key accepted but peer identity not confirmed — ready=false until peer appears",
					);
				}
			} else {
				notes.push(
					"netbird: set NETBIRD_MANAGEMENT_URL and join with the OverlayJoin from fleet enrollment for a live join",
				);
			}

			current = {
				nodeId,
				hostname: join.hostname,
				overlayIps,
				tags,
				tenantId: join.tenantId,
			};
			await options?.metering?.emit(
				createUsageEvent({
					tenantId: join.tenantId,
					eventType: "overlay.join",
					resource: join.hostname,
					metadata: {
						provider: "netbird",
						ready,
						...(managementUrl ? { managementUrl } : undefined),
					},
				}),
			);
			join.emitProgress?.(
				ready
					? `hobo overlay: netbird joined ${join.hostname}`
					: `hobo overlay: netbird join incomplete — ${notes[notes.length - 1] ?? "configure management API"}`,
			);
			return {
				identity: current,
				provider: "netbird",
				ready,
				notes,
			};
		},
		async status() {
			return current;
		},
		async leave() {
			if (current) {
				await options?.metering?.emit(
					createUsageEvent({
						tenantId: current.tenantId,
						eventType: "overlay.leave",
						resource: current.hostname,
						metadata: { provider: "netbird" },
					}),
				);
			}
			current = null;
		},
		async configureMagicDns(
			config: MagicDnsSplitConfig,
		): Promise<MagicDnsSplitResult> {
			const notes: string[] = [];
			const api = client();
			let applied = false;
			if (api) {
				try {
					const group = await api.upsertDnsNameserverGroup({
						name: `hobo-${config.tenantId}`,
						description: "HoBo hierarchical DNS zones",
						nameservers: config.nameservers.map((ip) => ({
							ip,
							nsType: "udp",
						})),
						domains: [...config.domains],
						enabled: true,
						primary: false,
					});
					applied = true;
					notes.push(
						`netbird DNS nameserver group ${group.name} domains=[${group.domains.join(",")}]`,
					);
				} catch (error) {
					notes.push(
						`netbird DNS upsert failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			} else {
				notes.push(
					"netbird DNS requires management URL + access token (NETBIRD_TOKEN)",
				);
			}
			await options?.metering?.emit(
				createUsageEvent({
					tenantId: config.tenantId,
					eventType: "overlay.magicdns",
					resource: config.domains.join(","),
					metadata: { provider: "netbird", applied },
				}),
			);
			return { applied, domains: config.domains, notes };
		},
		async publishFunnel(
			funnel: FunnelPublishOptions,
		): Promise<FunnelPublishResult> {
			const notes: string[] = [];
			// Netbird reverse-proxy / public access: use configured gateway hostname.
			let gateway =
				funnel.hostnameHint &&
				(funnel.hostnameHint.endsWith(".netbird.selfhosted") ||
					funnel.hostnameHint.endsWith(".nb.local") ||
					funnel.hostnameHint.includes("netbird"))
					? funnel.hostnameHint
					: null;

			const api = client();
			if (!gateway && api && current) {
				try {
					const peers = await api.listPeers();
					const hit = peers.find((p) => p.id === current?.nodeId);
					if (hit?.dnsLabel) {
						gateway = hit.dnsLabel;
						notes.push(`derived gateway from peer dns label ${gateway}`);
					}
				} catch (error) {
					notes.push(
						`peer lookup: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			if (!gateway) {
				notes.push(
					"pass hostnameHint for netbird reverse-proxy / public domain, or ensure peer has dns_label",
				);
			}

			try {
				await options?.metering?.emit(
					createUsageEvent({
						tenantId: funnel.tenantId,
						eventType: "overlay.funnel",
						resource: gateway ?? "funnel",
						metadata: {
							provider: "netbird",
							enabled: false,
							gateway: gateway ?? "",
						},
					}),
				);
			} catch {
				// Public-route capability remains authoritative when observation fails.
			}
			return {
				enabled: false,
				confirmed: false,
				gatewayHostname: gateway,
				notes: [
					...notes,
					"Netbird has no configured public reverse-proxy seam",
				],
			};
		},
	};
}
