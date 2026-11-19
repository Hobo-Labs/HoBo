import { BrowserWasmProviderError } from "./errors.js";
import type {
	ComponentArtifact,
	GuestManifest,
	PersistenceMode,
} from "./manifest.js";
import type { GuestPlacement } from "./placement.js";

export type InstantiateInput = {
	readonly placement: GuestPlacement;
	readonly manifest: GuestManifest;
	readonly artifact: ComponentArtifact;
	readonly bytes: Uint8Array;
	readonly persistence: PersistenceMode;
	readonly origin: string;
};

export type InstantiatedGuest = {
	readonly workerName: string;
	readonly partitionId: string;
	readonly instantiatedAtMs: number;
};

export type TerminateInput = {
	readonly guestId: string;
	readonly workerName: string;
	readonly partitionId: string;
	readonly dropPartition: boolean;
};

export type TerminationResult = {
	readonly workerTerminated: boolean;
	readonly partitionDropped: boolean;
};

export interface GuestRuntimePort {
	readonly providedImports: readonly string[];
	instantiate(input: InstantiateInput): Promise<InstantiatedGuest>;
	terminate(input: TerminateInput): Promise<TerminationResult>;
}

export function createUnavailableRuntime(reason: string): GuestRuntimePort {
	const unavailable = () =>
		new BrowserWasmProviderError(
			"HOST_UNSUPPORTED",
			`no browser WebAssembly runtime is available: ${reason}`,
		);
	return {
		providedImports: [],
		instantiate() {
			return Promise.reject(unavailable());
		},
		terminate() {
			return Promise.reject(unavailable());
		},
	};
}
