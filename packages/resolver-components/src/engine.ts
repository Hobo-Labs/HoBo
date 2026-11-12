// Engines turn verified component bytes into an export table the component
// host can load. The host never trusts an engine with policy: egress,
// credentials and limits are enforced on the import side, which every engine
// must route through `callImport` (the component host's link table).
//
// In-tree engine: `createGuestModuleEngine` binds a registered guest program
// to the exact wasm digest it was built into. Like @hobo/componentize, the
// in-tree build emits contract-shaped bytes, not a jco/StarlingMonkey guest,
// so the program runs in-process under the same lifted/lowered ABI a
// wasmtime engine would use. An engine that executes real component bytes
// plugs in behind the same interface (README "Engines").
import type { ComponentExport, InterfaceId } from "@hobo/core";
import {
	lower,
	liftEgressResult,
	liftInstancesPayload,
	liftResolveRequest,
} from "./guest/abi.js";
import type {
	ResolverGuestImports,
	ResolverGuestModule,
	WitHttpRequest,
	WitLogLevel,
} from "./guest/types.js";
import type { JsonValue } from "./json.js";
import {
	RESOLVER_HOST_IMPORT,
	type ResolverOperation,
	WASI_HTTP_OUTGOING,
} from "./wit.js";

/** Call a linked import through the component host. */
export type ImportCall = (
	importInterface: InterfaceId,
	operation: string,
	payload: JsonValue,
) => Promise<JsonValue>;

export interface EngineInstantiation {
	readonly componentId: string;
	/** Digest the host computed over the verified bytes. */
	readonly wasmDigest: string;
	readonly wasm: Uint8Array;
	readonly callImport: ImportCall;
}

/** The lowered `hobo:resolver/resolver` export table. */
export type ResolverExportTable = Readonly<Record<ResolverOperation, ComponentExport>>;

export interface ResolverComponentEngine {
	readonly kind: string;
	/** Instantiate; returns undefined when this engine cannot run the bytes. */
	instantiate(input: EngineInstantiation): ResolverExportTable | undefined;
}

/** Guest-side bindings: lift host results, lower guest calls. */
function guestImports(callImport: ImportCall): ResolverGuestImports {
	return Object.freeze({
		async log(level: WitLogLevel, message: string): Promise<void> {
			await callImport(RESOLVER_HOST_IMPORT, "log", lower({ level, message }));
		},
		async send(request: WitHttpRequest) {
			return liftEgressResult(await callImport(WASI_HTTP_OUTGOING, "send", lower(request)));
		},
		async authorizedFetch(request: WitHttpRequest, credentialRef: string) {
			return liftEgressResult(
				await callImport(
					RESOLVER_HOST_IMPORT,
					"authorized-fetch",
					lower({ request, credentialRef }),
				),
			);
		},
	});
}

/** Bind guest programs to the wasm digests they were built into. */
export function createGuestModuleEngine(
	modules: ReadonlyMap<string, ResolverGuestModule>,
): ResolverComponentEngine {
	return Object.freeze({
		kind: "guest-module",
		instantiate(input: EngineInstantiation): ResolverExportTable | undefined {
			const program = modules.get(input.wasmDigest);
			if (program === undefined) return undefined;
			const guest = program.instantiate(guestImports(input.callImport));
			return Object.freeze({
				describe: async () => lower(await guest.describe()),
				reconcile: async (payload: JsonValue) =>
					lower(await guest.reconcile(liftResolveRequest(payload))),
				read: async (payload: JsonValue) =>
					lower(await guest.read(liftResolveRequest(payload))),
				delete: async (payload: JsonValue) =>
					lower(await guest.delete(liftResolveRequest(payload))),
				instances: async (payload: JsonValue) => {
					const args = liftInstancesPayload(payload);
					return lower(await guest.instances(args.productId, args.credentialRef));
				},
			});
		},
	});
}

