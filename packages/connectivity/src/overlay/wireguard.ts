import { spawnSync } from "node:child_process";

import {
	createUsageEvent,
	type MeteringBus,
	type OverlayIdentity,
	type OverlayJoinOptions,
	type OverlayJoinResult,
	type OverlayNetwork,
	type PolicyEngine,
} from "@hobo/core";
import { isJsonString } from "../json.js";

export type WireguardRunner = (
	command: string,
	args: readonly string[],
) => { readonly ok: boolean; readonly stdout: string; readonly stderr: string };

interface WireguardProbe {
	readonly addresses: readonly string[];
	readonly error: string | null;
	readonly publicKey: string | null;
	readonly ready: boolean;
}

export function createWireguardOverlay(options?: {
	readonly metering?: MeteringBus;
	readonly policy?: PolicyEngine;
	readonly interfaceName?: string;
	readonly configPath?: string;
	readonly wgBin?: string;
	readonly wgQuickBin?: string;
	readonly ipBin?: string;
	readonly run?: WireguardRunner;
}): OverlayNetwork {
	const interfaceName = options?.interfaceName ?? "hobo0";
	const run: WireguardRunner =
		options?.run ??
		((command, args) => {
			const result = spawnSync(command, [...args], { encoding: "utf8" });
			return {
				ok: result.status === 0,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		});
	let current: OverlayIdentity | null = null;
	let started = false;

	function probe(): WireguardProbe {
		const status = run(options?.wgBin ?? "wg", ["show", interfaceName, "dump"]);
		if (!status.ok) {
			return {
				ready: false,
				publicKey: null,
				addresses: [],
				error:
					status.stderr.trim() ||
					status.stdout.trim() ||
					"interface unavailable",
			};
		}
		const publicKey = status.stdout.split(/\r?\n/u)[0]?.split("\t")[1] ?? null;
		const addresses = run(options?.ipBin ?? "ip", [
			"-json",
			"address",
			"show",
			"dev",
			interfaceName,
		]);
		let overlayIps: string[] = [];
		if (addresses.ok) {
			try {
				const parsed = JSON.parse(addresses.stdout) as {
					readonly addr_info?: readonly { readonly local?: unknown }[];
				}[];
				overlayIps = parsed
					.flatMap((entry) => entry.addr_info ?? [])
					.map((entry) => entry.local)
					.filter(isJsonString);
			} catch {
				overlayIps = [];
			}
		}
		return { ready: true, publicKey, addresses: overlayIps, error: null };
	}

	return {
		provider: "wireguard",
		tenantTags({ tenantId, role, env, cloud, overlayNetworkId }) {
			const tags = [`tenant:${tenantId}`, `role:${role}`];
			if (env) tags.push(`env:${env}`);
			if (cloud) tags.push(`cloud:${cloud}`);
			if (overlayNetworkId) tags.push(`overlay:${overlayNetworkId}`);
			return tags;
		},
		async join(join: OverlayJoinOptions): Promise<OverlayJoinResult> {
			const tags = [...join.tags];
			if (!tags.some((tag) => tag.startsWith("tenant:"))) {
				tags.push(`tenant:${join.tenantId}`);
			}
			if (options?.policy) {
				const decision = await options.policy.evaluate({
					subject: {
						identity: join.hostname,
						tenantId: join.tenantId,
						tags,
					},
					action: "overlay.join",
					resource: {
						kind: "overlay",
						id: "wireguard",
						tenantId: join.tenantId,
						tags,
					},
				});
				if (decision.effect === "deny") {
					return {
						identity: {
							nodeId: "denied",
							hostname: join.hostname,
							overlayIps: [],
							tags,
							tenantId: join.tenantId,
						},
						provider: "wireguard",
						ready: false,
						notes: decision.reasons,
					};
				}
			}

			let state = probe();
			const notes: string[] = [];
			if (!state.ready && options?.configPath) {
				const startedResult = run(options.wgQuickBin ?? "wg-quick", [
					"up",
					options.configPath,
				]);
				started = startedResult.ok;
				if (!startedResult.ok) {
					notes.push(
						startedResult.stderr.trim() ||
							startedResult.stdout.trim() ||
							"wg-quick failed",
					);
				}
				state = probe();
			}
			if (!state.ready && state.error) notes.push(state.error);
			current = {
				nodeId: `wireguard:${state.publicKey ?? join.hostname}`,
				hostname: join.hostname,
				overlayIps: state.addresses,
				tags,
				tenantId: join.tenantId,
			};
			await options?.metering?.emit(
				createUsageEvent({
					tenantId: join.tenantId,
					eventType: "overlay.join",
					resource: join.hostname,
					metadata: { provider: "wireguard", ready: state.ready },
				}),
			);
			join.emitProgress?.(
				state.ready
					? `hobo overlay: wireguard joined ${interfaceName}`
					: `hobo overlay: wireguard unavailable on ${interfaceName}`,
			);
			return {
				identity: current,
				provider: "wireguard",
				ready: state.ready,
				notes,
			};
		},
		async status() {
			return current;
		},
		async leave() {
			if (started && options?.configPath) {
				run(options.wgQuickBin ?? "wg-quick", ["down", options.configPath]);
			}
			if (current) {
				await options?.metering?.emit(
					createUsageEvent({
						tenantId: current.tenantId,
						eventType: "overlay.leave",
						resource: current.hostname,
						metadata: { provider: "wireguard" },
					}),
				);
			}
			current = null;
			started = false;
		},
	};
}
