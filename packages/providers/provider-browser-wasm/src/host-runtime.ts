/**
 * The host/guest boundary, as an injected port.
 *
 * This is the seam the HTTP transport does not cover. Once the bytes are
 * verified, instantiation is a same-process act performed by whatever runs the
 * component — a dedicated worker in a browser, a test double here — and this
 * package's job is to decide *whether* to instantiate, not to own the engine.
 *
 * The port declares `providedImports` because a missing import is a link error
 * raised from inside the runtime, long after the useful diagnosis was
 * available: the manifest said what the guest needs, and the host knows what it
 * supplies.
 */
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
	/** The persistence actually available, which may be weaker than requested. */
	readonly persistence: PersistenceMode;
	readonly origin: string;
};

export type InstantiatedGuest = {
	/** Dedicated worker name; empty when the guest runs on the main thread. */
	readonly workerName: string;
	/** OPFS partition; empty for transient or unavailable persistence. */
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
	/** WIT interface ids this host can satisfy for a guest. */
	readonly providedImports: readonly string[];
	instantiate(input: InstantiateInput): Promise<InstantiatedGuest>;
	terminate(input: TerminateInput): Promise<TerminationResult>;
}

/**
 * The default runtime outside a browser: none.
 *
 * Failing closed matters more here than elsewhere. A stand-in that "ran" the
 * guest would make every downstream receipt a claim about an instantiation
 * that never happened.
 */
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
