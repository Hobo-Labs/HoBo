import type {
	OverlayNetwork,
	OverlayProviderKind,
	PolicyEngine,
} from "@hobo/core";

import { createNetbirdOverlay } from "../overlay/netbird.js";
import { createTailscaleOverlay } from "../overlay/tailscale.js";
import { createWireguardOverlay } from "../overlay/wireguard.js";
import {
	defaultTierForClass,
	type IsolationClass,
	type IsolationTier,
	isolationClassTag,
} from "./types.js";

export type EnvOverlayPlane = Readonly<{
	isolationClass: IsolationClass;
	overlayNetworkId: string;
	overlay: OverlayNetwork;
	isolationTier: IsolationTier;
}>;

export type EnvControlPlanePartition = Readonly<{
	isolationClass: IsolationClass;
	partitionKey: string;
	eventStreamPrefix: string;
	overlayControlPlaneId: string;
}>;

export interface EnvNetworkIsolationRegistry {
	registerClass(
		cls: IsolationClass,
		options?: { readonly tier?: IsolationTier },
	): EnvOverlayPlane;
	getPlane(cls: IsolationClass): EnvOverlayPlane | null;
	getControlPlane(cls: IsolationClass): EnvControlPlanePartition | null;
	listPlanes(): readonly EnvOverlayPlane[];
	assertEnvironmentIsolation(
		a: IsolationClass,
		b: IsolationClass,
	): { readonly isolated: boolean; readonly reason: string };
	hardFloorOverlayId(cls: IsolationClass): string;
}

export interface EnvNetworkIsolationRegistryOptions {
	readonly defaultTier?: IsolationTier;
	readonly sharedOverlay?: OverlayNetwork;
	readonly policy?: PolicyEngine;
	readonly overlayProvider?: OverlayProviderKind;
	readonly createOverlayForClass?: (cls: IsolationClass) => OverlayNetwork;
}

function createOverlayNetwork(
	provider: OverlayProviderKind | undefined,
	policy: PolicyEngine | undefined,
): OverlayNetwork {
	if (provider === "netbird") return createNetbirdOverlay();
	if (provider === "tailscale") {
		return createTailscaleOverlay(policy === undefined ? {} : { policy });
	}
	return createWireguardOverlay(policy === undefined ? {} : { policy });
}

export function createEnvNetworkIsolationRegistry(
	options: EnvNetworkIsolationRegistryOptions = {},
): EnvNetworkIsolationRegistry {
	const shared =
		options.sharedOverlay ??
		createOverlayNetwork(options.overlayProvider, options.policy);

	const planes = new Map<IsolationClass, EnvOverlayPlane>();
	const controlPlanes = new Map<IsolationClass, EnvControlPlanePartition>();

	function createOverlay(cls: IsolationClass): OverlayNetwork {
		if (options.createOverlayForClass) {
			return options.createOverlayForClass(cls);
		}
		return createOverlayNetwork(options.overlayProvider, options.policy);
	}

	return {
		registerClass(cls, regOpts) {
			const tier =
				regOpts?.tier ?? options.defaultTier ?? defaultTierForClass(cls);
			const overlayNetworkId =
				tier === "soft" ? "shared-env" : `env-overlay-${cls}`;
			const overlay = tier === "soft" ? shared : createOverlay(cls);
			const plane: EnvOverlayPlane = Object.freeze({
				isolationClass: cls,
				overlayNetworkId,
				overlay,
				isolationTier: tier,
			});
			planes.set(cls, plane);

			if (tier === "hard-control-plane" || tier === "hard-overlay") {
				controlPlanes.set(cls, {
					isolationClass: cls,
					partitionKey: `env-cp-${cls}`,
					eventStreamPrefix: `env/${cls}/events`,
					overlayControlPlaneId: `overlay-cp-${cls}`,
				});
			} else {
				controlPlanes.delete(cls);
			}
			return plane;
		},
		getPlane(cls) {
			return planes.get(cls) ?? null;
		},
		getControlPlane(cls) {
			return controlPlanes.get(cls) ?? null;
		},
		listPlanes() {
			return [...planes.values()];
		},
		hardFloorOverlayId(cls) {
			return `env-overlay-${cls}`;
		},
		assertEnvironmentIsolation(a, b) {
			if (a === b) {
				return { isolated: false, reason: "same isolation class" };
			}
			const pa = planes.get(a);
			const pb = planes.get(b);
			if (!pa || !pb) {
				return {
					isolated: true,
					reason: "one or both isolation classes unregistered",
				};
			}
			if (pa.isolationTier === "soft" && pb.isolationTier === "soft") {
				return {
					isolated: false,
					reason: "both soft-isolated; rely on PolicyEngine for cross-env deny",
				};
			}
			if (pa.overlayNetworkId === pb.overlayNetworkId) {
				return {
					isolated: false,
					reason: `shared overlayNetworkId ${pa.overlayNetworkId}`,
				};
			}
			if (pa.overlay === pb.overlay) {
				return {
					isolated: false,
					reason: "shared OverlayNetwork instance",
				};
			}
			const cpa = controlPlanes.get(a);
			const cpb = controlPlanes.get(b);
			if (
				cpa &&
				cpb &&
				cpa.overlayControlPlaneId !== cpb.overlayControlPlaneId
			) {
				return {
					isolated: true,
					reason: `hard overlay control planes ${cpa.overlayControlPlaneId} vs ${cpb.overlayControlPlaneId}`,
				};
			}
			return {
				isolated: true,
				reason: `distinct env overlays ${pa.overlayNetworkId} vs ${pb.overlayNetworkId}`,
			};
		},
	};
}

export function envIsolationTags(cls: IsolationClass): readonly string[] {
	return Object.freeze([isolationClassTag(cls), `isolation-class:${cls}`]);
}
