import type {
	OverlayNetwork,
	Tenant,
	TenantId,
	TenantIsolationMode,
} from "@hobo/core";
import { parseTenantId } from "@hobo/core";

export interface TenantControlPlanePartition {
	readonly tenantId: TenantId;
	readonly partitionKey: string;
	/** Logical stream / store prefix for hard control-plane isolation. */
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
	/**
	 * Assert two subjects cannot share a hard-isolated plane.
	 * Soft tenants share the default overlay and rely on PolicyEngine.
	 */
	assertNetworkIsolation(
		a: TenantId | string,
		b: TenantId | string,
	): {
		readonly isolated: boolean;
		readonly reason: string;
	};
}

/**
 * The overlays the registry hands out; it never constructs one. `shared`
 * serves every soft tenant; `forTenant` gives a hard-isolated tenant its own
 * (a separate tailnet or NetBird account the host has joined).
 */
export interface TenantOverlays {
	readonly shared: OverlayNetwork;
	readonly forTenant?: (tenant: Tenant) => OverlayNetwork;
}

export interface TenantIsolationRegistryOptions {
	readonly defaultMode?: TenantIsolationMode;
}

/**
 * Hard multi-tenant isolation:
 * - soft: shared OverlayNetwork; isolation is PolicyEngine + IDs
 * - hard-overlay: dedicated OverlayNetwork instance + overlayNetworkId tags
 * - hard-control-plane: hard-overlay + dedicated control-plane partition keys
 */
export function createTenantIsolationRegistry(
	overlays: TenantOverlays,
	options: TenantIsolationRegistryOptions = {},
): TenantIsolationRegistry {
	const defaultMode = options.defaultMode ?? "soft";
	const shared = overlays.shared;

	const planes = new Map<string, TenantOverlayPlane>();
	const controlPlanes = new Map<string, TenantControlPlanePartition>();

	function createOverlay(tenant: Tenant): OverlayNetwork {
		if (overlays.forTenant === undefined)
			throw Object.assign(
				new Error(
					`tenant ${tenant.id} needs its own overlay for hard isolation; pass overlays.forTenant`,
				),
				{ code: "overlay-required" },
			);
		return overlays.forTenant(tenant);
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
