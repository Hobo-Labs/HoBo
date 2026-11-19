
import type { HostAssetClient } from "./client.js";
import { BrowserWasmProviderError } from "./errors.js";
import type { GuestRuntimePort } from "./host-runtime.js";
import type {
	ComponentArtifact,
	GuestManifest,
	HostCapabilities,
	PersistenceMode,
} from "./manifest.js";
import { PROVIDER_TARGET } from "./options.js";
import type { GuestPlacement } from "./placement.js";

// public-contract: versions persisted browser-WASM receipts.
export const RECEIPT_SCHEMA_VERSION = "hobo.provider-browser-wasm.receipt/v1";

export const GUEST_PHASES = [
	"fetched",
	"running",
	"terminated",
	"failed",
] as const;
export type GuestPhase = (typeof GUEST_PHASES)[number];

export type GuestHandle = {
	readonly guestId: string;
	readonly origin: string;
	readonly partitionId: string;
	readonly workerName: string;
	readonly phase: GuestPhase;
	readonly instantiatedAtMs: number;
	readonly failureReason: string;
};

export type ProvisionReceipt = {
	readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
	readonly providerId: typeof PROVIDER_TARGET;
	readonly placement: GuestPlacement;
	readonly host: HostCapabilities;
	readonly manifest: GuestManifest;
	readonly artifact: ComponentArtifact;
	readonly handle: GuestHandle;
	readonly effectivePersistence: PersistenceMode;
	readonly guestUrl: string;
};

export const CLEANUP_STATES = ["released", "retained", "orphaned"] as const;
export type CleanupState = (typeof CLEANUP_STATES)[number];

export type CleanupOutcome = {
	readonly guestId: string;
	readonly state: CleanupState;
	readonly workerTerminated: boolean;
	readonly partitionDropped: boolean;
	readonly releasedAtMs: number;
	readonly retainedReason: string;
};

export type ProvisionGuestInput = {
	readonly client: HostAssetClient;
	readonly runtime: GuestRuntimePort;
	readonly placement: GuestPlacement;
	readonly allowTransient?: boolean;
};

function unsupported(
	message: string,
	detail: Record<string, string | number | boolean>,
): BrowserWasmProviderError {
	return new BrowserWasmProviderError("HOST_UNSUPPORTED", message, { detail });
}

export function negotiatePersistence(input: {
	readonly placement: GuestPlacement;
	readonly host: HostCapabilities;
	readonly allowTransient: boolean;
}): PersistenceMode {
	const { placement, host } = input;
	if (placement.persistence === "transient-memory") return "transient-memory";
	if (host.persistence === "opfs-sahpool" && host.dedicatedWorkers) {
		return "opfs-sahpool";
	}
	if (input.allowTransient) return "transient-memory";
	throw new BrowserWasmProviderError(
		"PERSISTENCE_UNAVAILABLE",
		`${placement.guestId} asked for durable OPFS storage and this context reports ${host.persistence}`,
		{
			detail: {
				guestId: placement.guestId,
				hostPersistence: host.persistence,
				dedicatedWorkers: host.dedicatedWorkers,
			},
		},
	);
}

export async function provisionGuest(
	input: ProvisionGuestInput,
): Promise<ProvisionReceipt> {
	const { client, runtime, placement } = input;

	const host = await client.fetchHostCapabilities();

	if (placement.sharedMemory && !host.crossOriginIsolated) {
		throw unsupported(
			`${placement.guestId} asked for shared memory and the document is not cross-origin isolated`,
			{ guestId: placement.guestId },
		);
	}
	if (placement.memoryLimitBytes > host.maxMemoryBytes) {
		throw unsupported(
			`${placement.guestId} asked for ${placement.memoryLimitBytes} bytes and the host caps guests at ${host.maxMemoryBytes}`,
			{
				guestId: placement.guestId,
				requested: placement.memoryLimitBytes,
				hostMax: host.maxMemoryBytes,
			},
		);
	}

	const manifest = await client.fetchGuestManifest(placement.guestId);
	if (manifest.world !== placement.world) {
		throw unsupported(
			`the bundle for ${placement.guestId} targets ${manifest.world}, not the placement's ${placement.world}`,
			{ guestId: placement.guestId },
		);
	}
	if (manifest.port !== placement.port) {
		throw unsupported(
			`the bundle for ${placement.guestId} serves the ${manifest.port} port, not ${placement.port}`,
			{ guestId: placement.guestId },
		);
	}

	const missing = manifest.imports.filter(
		(id) => !runtime.providedImports.includes(id),
	);
	if (missing.length > 0) {
		throw unsupported(
			`this host cannot supply ${missing.join(", ")}, which ${placement.guestId} imports`,
			{ guestId: placement.guestId, missing: missing.join(",") },
		);
	}
	const unmet = placement.requiredImports.filter(
		(id) => !manifest.imports.includes(id),
	);
	if (unmet.length > 0) {
		throw unsupported(
			`${placement.guestId} was placed requiring ${unmet.join(", ")}, which its bundle does not import`,
			{ guestId: placement.guestId, unmet: unmet.join(",") },
		);
	}

	const effectivePersistence = negotiatePersistence({
		placement,
		host,
		allowTransient: input.allowTransient === true,
	});

	const { artifact, bytes } = await client.fetchComponent(manifest);

	let instantiated: Awaited<ReturnType<GuestRuntimePort["instantiate"]>>;
	try {
		instantiated = await runtime.instantiate({
			placement,
			manifest,
			artifact,
			bytes,
			persistence: effectivePersistence,
			origin: host.origin,
		});
	} catch (cause) {
		if (cause instanceof BrowserWasmProviderError) throw cause;
		throw new BrowserWasmProviderError(
			"GUEST_INSTANTIATION_FAILED",
			`${placement.guestId} did not instantiate`,
			{
				cause: cause instanceof Error ? cause : new Error(String(cause)),
				detail: { guestId: placement.guestId },
			},
		);
	}

	if (
		effectivePersistence === "opfs-sahpool" &&
		(instantiated.partitionId === "" || instantiated.workerName === "")
	) {
		throw new BrowserWasmProviderError(
			"PERSISTENCE_UNAVAILABLE",
			`${placement.guestId} was instantiated without the worker and partition durable storage needs`,
			{ detail: { guestId: placement.guestId } },
		);
	}

	const handle: GuestHandle = Object.freeze({
		guestId: placement.guestId,
		origin: host.origin,
		partitionId:
			effectivePersistence === "opfs-sahpool" ? instantiated.partitionId : "",
		workerName: instantiated.workerName,
		phase: "running" as const,
		instantiatedAtMs: instantiated.instantiatedAtMs,
		failureReason: "",
	});

	return Object.freeze({
		schemaVersion: RECEIPT_SCHEMA_VERSION,
		providerId: PROVIDER_TARGET,
		placement,
		host,
		manifest,
		artifact,
		handle,
		effectivePersistence,
		guestUrl: host.origin,
	});
}

export type ReleaseGuestInput = {
	readonly runtime: GuestRuntimePort;
	readonly receipt: ProvisionReceipt;
	readonly now: () => number;
	readonly retainPartition?: boolean;
};

export async function releaseGuest(
	input: ReleaseGuestInput,
): Promise<CleanupOutcome> {
	const { runtime, receipt, now } = input;
	const guestId = receipt.handle.guestId;
	const hasPartition = receipt.handle.partitionId !== "";
	const retain = input.retainPartition === true && hasPartition;

	const result = await runtime.terminate({
		guestId,
		workerName: receipt.handle.workerName,
		partitionId: receipt.handle.partitionId,
		dropPartition: !retain,
	});

	if (!result.workerTerminated) {
		throw new BrowserWasmProviderError(
			"CLEANUP_INCOMPLETE",
			`${guestId} did not release its worker`,
			{ detail: { guestId } },
		);
	}

	if (retain) {
		return Object.freeze({
			guestId,
			state: "retained" as const,
			workerTerminated: true,
			partitionDropped: false,
			releasedAtMs: now(),
			retainedReason: "partition-reuse",
		});
	}

	if (hasPartition && !result.partitionDropped) {
		throw new BrowserWasmProviderError(
			"CLEANUP_INCOMPLETE",
			`${guestId} kept its OPFS partition after an unconditional release`,
			{ detail: { guestId, partitionId: receipt.handle.partitionId } },
		);
	}

	return Object.freeze({
		guestId,
		state: "released" as const,
		workerTerminated: true,
		partitionDropped: true,
		releasedAtMs: now(),
		retainedReason: "",
	});
}

export function orphanedGuest(
	guestId: string,
	observedAtMs: number,
): CleanupOutcome {
	return Object.freeze({
		guestId,
		state: "orphaned" as const,
		workerTerminated: false,
		partitionDropped: false,
		releasedAtMs: observedAtMs,
		retainedReason: "tab-closed",
	});
}
