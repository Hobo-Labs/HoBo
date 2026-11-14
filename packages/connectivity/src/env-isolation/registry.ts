/**
 * EnvNetworkIsolationRegistry — parallel to TenantIsolationRegistry.
 * Soft / hard-overlay / hard-control-plane for environment isolation classes.
 */
import type { OverlayNetwork } from "@hobo/core";

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
	/** Distinct tailnet / Netbird network id for hard floor. */
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
	/**
	 * Assert two isolation classes cannot share a hard-isolated plane.
	 * Soft classes share default overlay and rely on PolicyEngine env deny.
	 */
	assertEnvironmentIsolation(
		a: IsolationClass,
		b: IsolationClass,
	): { readonly isolated: boolean; readonly reason: string };
	/** Recommended distinct overlay network id for hard-floor production. */
	hardFloorOverlayId(cls: IsolationClass): string;
}

/**
 * The overlays the registry hands out; it never constructs one. `shared`
 * serves every soft class; `forClass` gives a hard-isolated class its own.
 */
export interface EnvOverlays {
	readonly shared: OverlayNetwork;
	readonly forClass?: (cls: IsolationClass) => OverlayNetwork;
}

export interface EnvNetworkIsolationRegistryOptions {
	readonly defaultTier?: IsolationTier;
}

export function createEnvNetworkIsolationRegistry(
	overlays: EnvOverlays,
	options: EnvNetworkIsolationRegistryOptions = {},
): EnvNetworkIsolationRegistry {
	const shared = overlays.shared;

	const planes = new Map<IsolationClass, EnvOverlayPlane>();
	const controlPlanes = new Map<IsolationClass, EnvControlPlanePartition>();

	function createOverlay(cls: IsolationClass): OverlayNetwork {
		if (overlays.forClass === undefined)
			throw Object.assign(
				new Error(
					`isolation class ${cls} needs its own overlay for a hard tier; pass overlays.forClass`,
				),
				{ code: "overlay-required" },
			);
		return overlays.forClass(cls);
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
				// Unregistered → fail closed: treat as isolated.
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

/** Stamp isolation class as overlay tags. */
export function envIsolationTags(cls: IsolationClass): readonly string[] {
	return Object.freeze([isolationClassTag(cls), `isolation-class:${cls}`]);
}
