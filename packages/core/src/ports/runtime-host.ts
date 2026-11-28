import { isJsonString, type JsonObject, type JsonValue } from "../json.js";

export const HOBO_RUNTIME_HOST_KINDS = [
	"local",
	"wasm",
	"oci",
	"cloud-native",
	"dapr",
] as const;

export type HoboRuntimeHostKind = (typeof HOBO_RUNTIME_HOST_KINDS)[number];

export type FetchHandler = (input: Request) => Response | Promise<Response>;

export interface RuntimeEnsureContext {
	readonly hoboHome: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly emitProgress?: (message: string) => void;
}

export interface RuntimeEnsureResult {
	readonly kind: HoboRuntimeHostKind;
	readonly ready: boolean;
	readonly notes: readonly string[];
	readonly details?: JsonObject;
}

export interface PrivateComponentSpec {
	readonly resourceName: string;
	readonly projectDir: string;
	readonly modulePath?: string;
	readonly wasmPath?: string;
	readonly handler?: FetchHandler;
}

export interface ServePrivateContext {
	readonly hoboHome: string;
	readonly projectDir: string;
	readonly privateComponents: readonly PrivateComponentSpec[];
	readonly bindleEnv?: Readonly<Record<string, string>>;
	readonly emitProgress?: (message: string) => void;
	readonly env?: NodeJS.ProcessEnv;
}

export interface IsolationInfo {
	readonly isolateBoundary: string;
	readonly privateSandboxes: number;
	readonly details?: JsonObject;
}

export interface PrivateServeResult {
	readonly kind: HoboRuntimeHostKind;
	readonly handlers: ReadonlyMap<string, FetchHandler>;
	readonly isolation: IsolationInfo;
	readonly close: () => Promise<void>;
}

export interface HoboRuntimeHost {
	readonly kind: HoboRuntimeHostKind;
	ensure(ctx: RuntimeEnsureContext): Promise<RuntimeEnsureResult>;
	servePrivate(ctx: ServePrivateContext): Promise<PrivateServeResult>;
}

export function isHoboRuntimeHostKind(
	value: JsonValue | undefined,
): value is HoboRuntimeHostKind {
	return (
		isJsonString(value) &&
		// SAFETY: assertion required at this I/O or test boundary.
		(HOBO_RUNTIME_HOST_KINDS as readonly string[]).includes(value)
	);
}
