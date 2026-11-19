import type {
	OverlayNetwork,
	PolicyEngine,
	Tenant,
	TenantId,
	TenantIsolationMode,
} from "@hobo/core";
import { parseTenantId } from "@hobo/core";

import { createNetbirdOverlay } from "../overlay/netbird.js";
import { createTailscaleOverlay } from "../overlay/tailscale.js";

export interface TenantControlPlanePartition {
	readonly tenantId: TenantId;
	readonly partitionKey: string;
	readonly eventStreamPrefix: string;
	readonly brokerNamespace: string;
}

export interface TenantOverlayPlane {
	readonly tenantId: TenantId;
	readonly overlayNetworkId: string;
	readonly overlay: OverlayNetwork;
	readonly isolationMode: TenantIsolationMode;
}

export interface TenantIsolationRegistry {
	registerTenant(tenant: Tenant): TenantOverlayPlane;
	getOverlay(tenantId: TenantId | string): OverlayNetwork | null;
	getPlane(tenantId: TenantId | string): TenantOverlayPlane | null;
	getControlPlane(
		tenantId: TenantId | string,
	): TenantControlPlanePartition | null;
	listPlanes(): readonly TenantOverlayPlane[];
	assertNetworkIsolation(
		a: TenantId | string,
		b: TenantId | string,
	): {
		readonly isolated: boolean;
		readonly reason: string;
	};
}

export interface TenantIsolationRegistryOptions {
	readonly defaultMode?: TenantIsolationMode;
	readonly sharedOverlay?: OverlayNetwork;
	readonly policy?: PolicyEngine;
	readonly createOverlayForTenant?: (tenant: Tenant) => OverlayNetwork;
	readonly overlayProvider?: "tailscale" | "netbird";
}

export function createTenantIsolationRegistry(
	options: TenantIsolationRegistryOptions = {},
): TenantIsolationRegistry {
	const defaultMode = options.defaultMode ?? "soft";
	const shared =
		options.sharedOverlay ??
		(options.overlayProvider === "netbird"
			? createNetbirdOverlay()
			: createTailscaleOverlay(
					options.policy !== undefined ? { policy: options.policy } : {},
				));

	const planes = new Map<string, TenantOverlayPlane>();
	const controlPlanes = new Map<string, TenantControlPlanePartition>();

	function createOverlay(tenant: Tenant): OverlayNetwork {
		if (options.createOverlayForTenant) {
			return options.createOverlayForTenant(tenant);
		}
		if (options.overlayProvider === "netbird") {
			return createNetbirdOverlay();
		}
		return createTailscaleOverlay(
			options.policy !== undefined ? { policy: options.policy } : {},
		);
	}

	return {
		registerTenant(tenant) {
			const mode = tenant.isolationMode ?? defaultMode;
			const overlayNetworkId =
				tenant.overlayNetworkId ??
				(mode === "soft" ? "shared" : `overlay-${tenant.slug || tenant.id}`);

			const overlay = mode === "soft" ? shared : createOverlay(tenant);

			const plane: TenantOverlayPlane = {
				tenantId: tenant.id,
				overlayNetworkId,
				overlay,
				isolationMode: mode,
			};
			planes.set(tenant.id, plane);

			if (mode === "hard-control-plane") {
				const partitionKey = tenant.controlPlanePartition ?? `cp-${tenant.id}`;
				controlPlanes.set(tenant.id, {
					tenantId: tenant.id,
					partitionKey,
					eventStreamPrefix: `tenant/${tenant.id}/events`,
					brokerNamespace: `broker.${tenant.id}`,
				});
			} else {
				controlPlanes.delete(tenant.id);
			}

			return plane;
		},
		getOverlay(tenantId) {
			const id = String(tenantId);
			return planes.get(id)?.overlay ?? null;
		},
		getPlane(tenantId) {
			return planes.get(String(tenantId)) ?? null;
		},
		getControlPlane(tenantId) {
			return controlPlanes.get(String(tenantId)) ?? null;
		},
		listPlanes() {
			return [...planes.values()];
		},
		assertNetworkIsolation(a, b) {
			const pa = planes.get(String(a));
			const pb = planes.get(String(b));
			if (!pa || !pb) {
				return {
					isolated: true,
					reason: "one or both tenants unregistered",
				};
			}
			if (pa.tenantId === pb.tenantId) {
				return { isolated: false, reason: "same tenant" };
			}
			if (pa.isolationMode === "soft" && pb.isolationMode === "soft") {
				return {
					isolated: false,
					reason:
						"both soft-isolated; rely on PolicyEngine for cross-tenant deny",
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
			const cpa = controlPlanes.get(String(a));
			const cpb = controlPlanes.get(String(b));
			if (cpa && cpb && cpa.partitionKey !== cpb.partitionKey) {
				return {
					isolated: true,
					reason: `hard control-plane partitions ${cpa.partitionKey} vs ${cpb.partitionKey}`,
				};
			}
			return {
				isolated: true,
				reason: `distinct overlays ${pa.overlayNetworkId} vs ${pb.overlayNetworkId}`,
			};
		},
	};
}

export function tenantFromSlug(
	slug: string,
	mode: TenantIsolationMode = "soft",
): Tenant {
	const id = parseTenantId(slug);
	return {
		id,
		slug,
		displayName: slug,
		createdAt: new Date().toISOString(),
		isolationMode: mode,
		...(mode !== "soft" ? { overlayNetworkId: `overlay-${slug}` } : undefined),
		...(mode === "hard-control-plane"
			? { controlPlanePartition: `cp-${slug}` }
			: undefined),
	};
}
