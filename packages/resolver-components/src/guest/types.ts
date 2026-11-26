// The guest-side view of the hobo:resolver@0.1.0 world (wit/resolver.wit):
// what a component author implements and what the host provides. These are
// WIT records in their canonical JSON lowering (records → objects, tuples →
// two-element arrays, option → value or null, result → {ok}|{err},
// variant → {tag, val}); they are not protobuf records.

export type WitLogLevel = "debug" | "info" | "warn" | "error";

export type WitHeader = readonly [string, string];

export interface WitHttpRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly WitHeader[];
	readonly body: string | null;
}

export interface WitHttpResponse {
	readonly status: number;
	readonly headers: readonly WitHeader[];
	readonly body: string;
}

export interface WitResourceRef {
	readonly slot: string;
	readonly productId: string;
	readonly logicalId: string;
	readonly physicalId: string | null;
}

export interface WitResolveRequest {
	readonly ref: WitResourceRef;
	readonly desiredJson: string;
	readonly observedJson: string | null;
	readonly credentialRef: string;
}

export type WitResolverAction =
	| "create"
	| "update"
	| "replace"
	| "delete"
	| "adopt"
	| "noop";

export interface WitResolveOutcome {
	readonly action: WitResolverAction;
	readonly physicalId: string;
	readonly outputsJson: string;
	readonly diagnostics: readonly string[];
}

export interface WitReadResult {
	readonly outcome: WitResolveOutcome;
	readonly attributes: readonly WitHeader[];
}

export interface WitResourceClass {
	readonly productId: string;
	readonly slot: string;
	readonly retainedFields: readonly string[];
	readonly observeFields: readonly string[];
	readonly directives: readonly string[];
}

export interface WitDescription {
	readonly componentId: string;
	readonly version: string;
	readonly classes: readonly WitResourceClass[];
}

export interface WitInstance {
	readonly logicalId: string;
	readonly physicalId: string;
}

export type WitResolverError =
	| { readonly tag: "rejected"; readonly val: string }
	| { readonly tag: "unsupported"; readonly val: string };

export type WitResult<T> =
	| { readonly ok: T }
	| { readonly err: WitResolverError };

export type WitEgressResult =
	| { readonly ok: WitHttpResponse }
	| { readonly err: { readonly tag: "denied"; readonly val: string } };

/** Host imports: `hobo:resolver/host` and `wasi:http/outgoing-handler`. */
export interface ResolverGuestImports {
	log(level: WitLogLevel, message: string): Promise<void>;
	/** wasi:http outgoing-handler `send`: unauthenticated, host-mediated. */
	send(request: WitHttpRequest): Promise<WitEgressResult>;
	/** The host attaches the credential named by `credentialRef`. */
	authorizedFetch(
		request: WitHttpRequest,
		credentialRef: string,
	): Promise<WitEgressResult>;
}

/** The `hobo:resolver/resolver` export. */
export interface ResolverGuestExports {
	describe(): Promise<WitDescription>;
	reconcile(request: WitResolveRequest): Promise<WitResult<WitResolveOutcome>>;
	read(request: WitResolveRequest): Promise<WitResult<WitReadResult | null>>;
	delete(request: WitResolveRequest): Promise<WitResult<null>>;
	instances(
		productId: string,
		credentialRef: string,
	): Promise<WitResult<readonly WitInstance[]>>;
}

/** A component's guest program: instantiated once per host instance. */
export interface ResolverGuestModule {
	instantiate(imports: ResolverGuestImports): ResolverGuestExports;
}
