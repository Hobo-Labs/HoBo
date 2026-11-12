// The component host for resolver components. One `ComponentRuntime` owns
// one verified component and instantiates it through the @hobo/core
// `ComponentHostPort` (runtime-local / runtime-wasm): the component's
// imports (`hobo:resolver/host`, `wasi:http/outgoing-handler`) are linked to
// a host provider registered by this runtime, so every outbound byte goes
// through the link table and through the checks here:
//   - egress: signed allowlist + relay SSRF rules (./egress.ts);
//   - credentials: resolved and attached host-side, only to the call's own
//     locator and only to hosts in the signed credential binding; upstream
//     responses are redacted before the component reads them, and anything
//     the component emits is scanned (./secrets.ts);
//   - limits: deterministic fuel/memory metering and a deadline (./limits.ts).
// Calls on one instance are serialized, like a single wasm instance, and an
// instance that trapped or tripped a limit is torn down and re-instantiated
// fresh on the next call. Any denial during a call fails the call closed,
// even if the component swallowed the error.
import type { CredentialResolver, TelemetrySink } from "@hobo/cd";
import { create } from "@bufbuild/protobuf";
import {
	type ComponentHostPort,
	type HttpTransport,
	TRANSPORT_METHODS,
	type TransportMethod,
	type TransportRequest,
	type TransportResponse,
	guardTransport,
	TransportGuardError,
	type ParsedComponentDescriptor,
} from "@hobo/core";
import {
	type ComponentInvocationRecord,
	ComponentInvocationRecordSchema,
	EgressDenialCode,
	EgressDenialRecordSchema,
	InvocationOutcome,
} from "./_generated/resolver_components_pb.js";
import type { VerifiedResolverComponent } from "./bundle.js";
import type { ResolverComponentEngine, ResolverExportTable } from "./engine.js";
import { type AddressResolver, checkEgress, type EgressDenial } from "./egress.js";
import { ResolverComponentError, type ResolverComponentErrorCode } from "./errors.js";
import {
	AbiError,
	liftAuthorizedFetch,
	liftDescription,
	liftHttpRequest,
	liftLog,
	lower,
} from "./guest/abi.js";
import type { WitHttpRequest, WitHttpResponse, WitLogLevel } from "./guest/types.js";
import { isJsonObject, type JsonValue } from "./json.js";
import {
	CallMeter,
	type ComponentTimers,
	FUEL_COSTS,
	LimitTrap,
	systemTimers,
} from "./limits.js";
import {
	type ComponentResourceClass,
	compare,
	type ReconcilerMode,
} from "./manifest.js";
import { createSecretScanner, type SecretScanner } from "./secrets.js";
import { invocationMetrics } from "./telemetry.js";
import {
	RESOLVER_EXPORT,
	RESOLVER_HOST_IMPORT,
	type ResolverOperation,
	WASI_HTTP_OUTGOING,
} from "./wit.js";

/** Headers a component may not set: the host owns framing and auth. */
const HOST_OWNED_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"host",
	"content-length",
	"transfer-encoding",
	"connection",
	"forwarded",
	"x-forwarded-for",
	"x-forwarded-host",
]);

/** Log lines kept per call (bounded so a chatty guest cannot grow memory). */
const MAX_LOG_LINES = 64;

export interface ComponentLogLine {
	readonly level: WitLogLevel;
	readonly message: string;
}

/** Deterministic describe() cache, keyed by wasm and manifest digest. */
export type DescribeCache = Map<string, readonly ComponentResourceClass[]>;

export function createDescribeCache(): DescribeCache {
	return new Map();
}

export interface ResolverComponentHostOptions {
	readonly componentHost: ComponentHostPort;
	readonly engine: ResolverComponentEngine;
	readonly mode: ReconcilerMode;
	readonly resolveHost: AddressResolver;
	/** Where credential locators resolve: Station broker or agent-local. */
	readonly credentials: CredentialResolver;
	readonly telemetry?: TelemetrySink;
	readonly now?: () => number;
	readonly timers?: ComponentTimers;
	readonly describeCache?: DescribeCache;
	readonly onInvocation?: (record: ComponentInvocationRecord) => void;
	readonly onLog?: (componentId: string, line: ComponentLogLine) => void;
}

/** What one call may do: its transport and the credential locator it carries. */
export interface CallScope {
	readonly productId: string;
	readonly transport?: HttpTransport;
	readonly credentialRef?: string;
}

interface CallState {
	readonly scope: CallScope;
	readonly meter: CallMeter;
	readonly denials: EgressDenial[];
	readonly logs: ComponentLogLine[];
	material: string[];
	scanner: SecretScanner;
	egressCalls: number;
}

/** A loaded component: verified, instantiated once, describe() checked. */
export interface LoadedResolverComponent {
	readonly verified: VerifiedResolverComponent;
	readonly classes: readonly ComponentResourceClass[];
	invoke(
		operation: ResolverOperation,
		payload: JsonValue,
		scope: CallScope,
	): Promise<JsonValue>;
}

/** Verify-time + describe-time load. Throws a typed refusal. */
export async function loadResolverComponent(
	verified: VerifiedResolverComponent,
	options: ResolverComponentHostOptions,
): Promise<LoadedResolverComponent> {
	const manifest = verified.manifest;
	if (!manifest.modes.includes(options.mode))
		throw new ResolverComponentError(
			"component.manifest-invalid",
			`component runs in ${manifest.modes.join(", ")}, not ${options.mode}`,
			manifest.id,
		);
	const runtime = new ComponentRuntime(verified, options);
	await runtime.describe();
	return runtime;
}

class ComponentRuntime implements LoadedResolverComponent {
	readonly verified: VerifiedResolverComponent;
	readonly #options: ResolverComponentHostOptions;
	readonly #now: () => number;
	readonly #timers: ComponentTimers;
	readonly #cache: DescribeCache;
	#classes: readonly ComponentResourceClass[] | undefined;
	#instanceId: string | undefined;
	#exports: ResolverExportTable | undefined;
	#generation = 0;
	#call: CallState | undefined;
	#queue: Promise<void> = Promise.resolve();

	constructor(verified: VerifiedResolverComponent, options: ResolverComponentHostOptions) {
		this.verified = verified;
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#timers = options.timers ?? systemTimers;
		this.#cache = options.describeCache ?? createDescribeCache();
	}

	get classes(): readonly ComponentResourceClass[] {
		return this.#classes ?? this.verified.manifest.classes;
	}

	get #id(): string {
		return this.verified.manifest.id;
	}

	/** describe(), cached by content digest, checked against the signed manifest. */
	async describe(): Promise<readonly ComponentResourceClass[]> {
		const key = `${this.verified.wasmDigest}|${this.verified.manifestDigest}`;
		const cached = this.#cache.get(key);
		if (cached !== undefined) {
			this.#classes = cached;
			return cached;
		}
		const raw = await this.invoke("describe", null, { productId: "" });
		let description: ReturnType<typeof liftDescription>;
		try {
			description = liftDescription(raw);
		} catch (caught) {
			throw this.#refuse(
				"component.output-unparseable",
				caught instanceof Error ? caught.message : "describe() output is unparseable",
			);
		}
		const manifest = this.verified.manifest;
		const declared = canonicalClasses(manifest.classes);
		const described = canonicalClasses(
			description.classes.map((entry) => ({
				productId: entry.productId,
				slot: entry.slot,
				retainedFields: entry.retainedFields,
				observeFields: entry.observeFields,
				directives: entry.directives,
			})),
		);
		if (
			description.componentId !== manifest.id ||
			description.version !== manifest.version ||
			declared !== described
		)
			throw this.#refuse(
				"component.describe-mismatch",
				`describe() returned ${description.componentId}@${description.version} ${described}; the signed manifest declares ${manifest.id}@${manifest.version} ${declared}`,
			);
		this.#cache.set(key, manifest.classes);
		this.#classes = manifest.classes;
		return manifest.classes;
	}

	invoke(operation: ResolverOperation, payload: JsonValue, scope: CallScope): Promise<JsonValue> {
		const run = this.#queue.then(() => this.#invokeNow(operation, payload, scope));
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #invokeNow(
		operation: ResolverOperation,
		payload: JsonValue,
		scope: CallScope,
	): Promise<JsonValue> {
		const call: CallState = {
			scope,
			meter: new CallMeter(this.verified.manifest.limits, this.#now),
			denials: [],
			logs: [],
			material: [],
			scanner: createSecretScanner([]),
			egressCalls: 0,
		};
		this.#call = call;
		let outcome = InvocationOutcome.OK;
		try {
			const exports = this.#instantiate();
			call.meter.charge(FUEL_COSTS.invoke);
			const payloadBytes = byteLength(JSON.stringify(payload));
			call.meter.charge(payloadBytes * FUEL_COSTS.perByte);
			call.meter.hold(payloadBytes);
			const result = await this.#withBackstop(call, () => exports[operation](payload));
			call.meter.checkDeadline();
			const text = JSON.stringify(result) ?? "null";
			call.meter.charge(byteLength(text) * FUEL_COSTS.perByte);
			call.meter.hold(byteLength(text));
			const firstDenial = call.denials[0];
			if (firstDenial !== undefined) {
				const exfiltration = call.denials.some(
					(denial) => denial.code === EgressDenialCode.SECRET_EXFILTRATION,
				);
				outcome = exfiltration
					? InvocationOutcome.SECRET_EXFILTRATION
					: InvocationOutcome.EGRESS_DENIED;
				throw this.#refuse(
					exfiltration ? "component.secret-exfiltration" : "component.egress-denied",
					`${operation}: ${call.denials.map((denial) => denial.detail).join("; ")}`,
					scope.productId,
				);
			}
			if (call.scanner.find(text)) {
				outcome = InvocationOutcome.SECRET_EXFILTRATION;
				call.denials.push(
					Object.freeze({
						code: EgressDenialCode.SECRET_EXFILTRATION,
						host: "",
						detail: `${operation} result carries injected credential material`,
					}),
				);
				throw this.#refuse(
					"component.secret-exfiltration",
					`${operation} result carries injected credential material; the result was withheld`,
					scope.productId,
				);
			}
			if (isGuestError(result)) outcome = InvocationOutcome.GUEST_ERROR;
			return result;
		} catch (caught) {
			const error = caught instanceof Error ? caught : new Error(String(caught));
			if (outcome === InvocationOutcome.OK) outcome = outcomeOf(error);
			this.#teardown();
			throw this.#asRefusal(error, operation, scope.productId);
		} finally {
			this.#call = undefined;
			this.#report(operation, scope.productId, call, outcome);
		}
	}

	#withBackstop(call: CallState, run: () => JsonValue | Promise<JsonValue>): Promise<JsonValue> {
		const remaining = Math.max(1, call.meter.deadline - this.#now());
		return new Promise<JsonValue>((resolve, reject) => {
			const cancel = this.#timers.set(remaining, () => reject(call.meter.expire()));
			Promise.resolve()
				.then(run)
				.then(
					(value) => {
						cancel();
						resolve(value);
					},
					(error: Error) => {
						cancel();
						reject(error);
					},
				);
		});
	}

	#instantiate(): ResolverExportTable {
		if (this.#exports !== undefined) return this.#exports;
		const host = this.#options.componentHost;
		this.#generation += 1;
		const instanceId = `${this.#id}@${this.verified.manifest.version}#${this.#generation}`;
		const exports = this.#options.engine.instantiate({
			componentId: instanceId,
			wasmDigest: this.verified.wasmDigest,
			wasm: this.verified.wasm,
			callImport: (importInterface, operation, payload) =>
				host.invokeLinkedImport(instanceId, importInterface, operation, payload),
		});
		if (exports === undefined)
			throw this.#refuse(
				"component.engine-unavailable",
				`engine ${this.#options.engine.kind} cannot instantiate ${this.verified.wasmDigest}`,
			);
		const descriptor: ParsedComponentDescriptor = {
			parsed: true,
			id: instanceId,
			imports: [RESOLVER_HOST_IMPORT, WASI_HTTP_OUTGOING],
			exports: { [RESOLVER_EXPORT]: { ...exports } },
		};
		host.loadComponent(descriptor);
		const providerId = `hobo-resolver-host/${instanceId}`;
		host.registerProvider({
			id: providerId,
			exports: {
				[RESOLVER_HOST_IMPORT]: {
					log: (payload: JsonValue) => this.#log(payload),
					"authorized-fetch": (payload: JsonValue) => this.#authorizedFetch(payload),
				},
				[WASI_HTTP_OUTGOING]: {
					send: (payload: JsonValue) => this.#send(payload),
				},
			},
		});
		for (const importInterface of [RESOLVER_HOST_IMPORT, WASI_HTTP_OUTGOING]) {
			host.link({
				componentId: instanceId,
				importInterface,
				providerId,
				exportInterface: importInterface,
			});
		}
		this.#instanceId = instanceId;
		this.#exports = exports;
		return exports;
	}

	#teardown(): void {
		const instanceId = this.#instanceId;
		this.#exports = undefined;
		this.#instanceId = undefined;
		if (instanceId === undefined) return;
		this.#options.componentHost.teardownComponent(instanceId).catch(() => undefined);
	}

	#current(): CallState {
		const call = this.#call;
		if (call === undefined)
			throw new LimitTrap("timeout", "import called outside an invocation");
		return call;
	}

	async #log(payload: JsonValue): Promise<JsonValue> {
		const call = this.#current();
		call.meter.charge(FUEL_COSTS.importCall);
		const line = liftLog(payload);
		call.meter.charge(byteLength(line.message) * FUEL_COSTS.perByte);
		call.meter.checkDeadline();
		if (call.scanner.find(line.message)) {
			this.#deny(call, EgressDenialCode.SECRET_EXFILTRATION, "", "log line carries injected credential material");
			return null;
		}
		if (call.logs.length < MAX_LOG_LINES) {
			call.logs.push(line);
			this.#options.onLog?.(this.#id, line);
		}
		return null;
	}

	#send(payload: JsonValue): Promise<JsonValue> {
		return this.#egress(liftHttpRequest(payload), undefined);
	}

	#authorizedFetch(payload: JsonValue): Promise<JsonValue> {
		const args = liftAuthorizedFetch(payload);
		return this.#egress(args.request, args.credentialRef);
	}

	async #egress(request: WitHttpRequest, credentialRef: string | undefined): Promise<JsonValue> {
		const call = this.#current();
		const manifest = this.verified.manifest;
		const requestText = `${request.url}\n${request.headers.map(([name, value]) => `${name}:${value}`).join("\n")}\n${request.body ?? ""}`;
		call.meter.charge(FUEL_COSTS.importCall + byteLength(requestText) * FUEL_COSTS.perByte);
		call.meter.hold(byteLength(requestText));
		call.meter.checkDeadline();
		call.egressCalls += 1;
		if (call.scanner.find(requestText))
			return this.#denied(
				call,
				EgressDenialCode.SECRET_EXFILTRATION,
				hostOf(request.url),
				"outbound request carries injected credential material",
			);
		const method = TRANSPORT_METHODS.find((candidate) => candidate === request.method.toUpperCase());
		if (method === undefined)
			return this.#denied(call, EgressDenialCode.SCHEME_FORBIDDEN, hostOf(request.url), `method ${request.method} is not allowed`);
		const verdict = await checkEgress(request.url, {
			manifest,
			mode: this.#options.mode,
			resolveHost: this.#options.resolveHost,
		});
		if (!verdict.ok)
			return this.#denied(call, verdict.denial.code, verdict.denial.host, verdict.denial.detail);
		const transport = call.scope.transport;
		if (transport === undefined)
			return this.#denied(call, EgressDenialCode.HOST_NOT_ALLOWLISTED, verdict.entry.host, "no egress during describe");
		const headers: Record<string, string> = {};
		for (const [name, value] of request.headers) {
			if (!HOST_OWNED_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
		}
		if (credentialRef !== undefined) {
			if (credentialRef !== call.scope.credentialRef)
				return this.#denied(call, EgressDenialCode.CREDENTIAL_SCOPE, verdict.entry.host, "credential locator is not the one this call carries");
			if (!manifest.credentialHosts.includes(verdict.entry.host))
				return this.#denied(call, EgressDenialCode.CREDENTIAL_SCOPE, verdict.entry.host, `credential binding does not include ${verdict.entry.host}`);
			let material: Readonly<Record<string, string>>;
			try {
				material = await this.#options.credentials.resolve(
					credentialRef,
					`resolver-component:${manifest.id}:${verdict.entry.host}`,
				);
			} catch (caught) {
				throw this.#refuse(
					"component.credential-unavailable",
					caught instanceof Error ? caught.message : "credential locator did not resolve",
					call.scope.productId,
				);
			}
			for (const [name, value] of Object.entries(material)) {
				headers[name.toLowerCase()] = value;
				call.material.push(value);
			}
			call.scanner = createSecretScanner(call.material);
		}
		const guarded = guardTransport(transport, {
			allowedHosts: [verdict.entry.host],
			allowedPathPrefixes: verdict.entry.pathPrefixes,
			allowedPorts: verdict.entry.ports,
			maxTimeoutMs: manifest.limits.callTimeoutMs,
			maxResponseBytes: manifest.limits.memoryBytes,
		});
		let response: TransportResponse;
		try {
			response = await guarded(transportRequest(method, verdict.url, headers, request.body, call, manifest.limits.memoryBytes, this.#now()));
		} catch (caught) {
			const error = caught instanceof Error ? caught : new Error(String(caught));
			if (error instanceof TransportGuardError) {
				const code =
					error.code === "TRANSPORT_REDIRECT_REFUSED"
						? EgressDenialCode.REDIRECT
						: error.code === "TRANSPORT_BODY_TOO_LARGE"
							? EgressDenialCode.BODY_TOO_LARGE
							: EgressDenialCode.HOST_NOT_ALLOWLISTED;
				if (error.code === "TRANSPORT_TIMEOUT_EXCEEDED") throw call.meter.expire();
				return this.#denied(call, code, verdict.entry.host, error.message);
			}
			throw error;
		}
		return lower({ ok: this.#admitResponse(call, verdict.entry.host, response) });
	}

	#admitResponse(call: CallState, host: string, response: TransportResponse): WitHttpResponse {
		const headerPairs = Object.keys(response.headers)
			.sort(compare)
			.map((name): readonly [string, string] => [name, response.headers[name] ?? ""]);
		const responseText = `${headerPairs.map(([name, value]) => `${name}:${value}`).join("\n")}\n${response.body}`;
		call.meter.charge(byteLength(responseText) * FUEL_COSTS.perByte);
		call.meter.hold(byteLength(responseText));
		call.meter.checkDeadline();
		if (response.status >= 300 && response.status < 400)
			this.#deny(call, EgressDenialCode.REDIRECT, host, `upstream answered ${response.status}; redirects are never followed`);
		if (call.scanner.find(responseText))
			this.#deny(call, EgressDenialCode.SECRET_EXFILTRATION, host, "upstream response echoed injected credential material; it was redacted before the component read it");
		return Object.freeze({
			status: response.status,
			headers: Object.freeze(
				headerPairs.map(([name, value]) => Object.freeze([name, call.scanner.redact(value)] as const)),
			),
			body: call.scanner.redact(response.body),
		});
	}

	#deny(call: CallState, code: EgressDenialCode, host: string, detail: string): void {
		call.denials.push(Object.freeze({ code, host, detail }));
	}

	#denied(call: CallState, code: EgressDenialCode, host: string, detail: string): JsonValue {
		this.#deny(call, code, host, detail);
		return lower({ err: { tag: "denied", val: detail } });
	}

	#refuse(code: ResolverComponentErrorCode, message: string, productId?: string): ResolverComponentError {
		return new ResolverComponentError(code, message, this.#id, productId);
	}

	#asRefusal(error: Error | ResolverComponentError, operation: string, productId: string): ResolverComponentError {
		if (error instanceof ResolverComponentError) return error;
		if (error instanceof LimitTrap)
			return this.#refuse(LIMIT_CODES[error.kind], `${operation}: ${error.message}`, productId);
		if (error instanceof AbiError)
			return this.#refuse("component.output-unparseable", `${operation}: ${error.message}`, productId);
		return this.#refuse("component.trap", `${operation}: ${errorMessage(error)}`, productId);
	}

	#report(operation: ResolverOperation, productId: string, call: CallState, outcome: InvocationOutcome): void {
		const record = create(ComponentInvocationRecordSchema, {
			componentId: this.#id,
			wasmDigest: this.verified.wasmDigest,
			productId,
			operation,
			outcome,
			fuelUsed: BigInt(Math.min(call.meter.fuelUsed, this.verified.manifest.limits.fuel)),
			peakMemoryBytes: BigInt(call.meter.peakMemoryBytes),
			durationMs: call.meter.durationMs,
			egressCalls: call.egressCalls,
			denials: call.denials.map((denial) =>
				create(EgressDenialRecordSchema, {
					code: denial.code,
					host: denial.host,
					detail: denial.detail,
				}),
			),
		});
		this.#options.onInvocation?.(record);
		const sink = this.#options.telemetry;
		if (sink !== undefined)
			sink.metrics(invocationMetrics(record, this.#now())).catch(() => undefined);
	}
}

const LIMIT_CODES = Object.freeze({
	fuel: "component.fuel-exhausted",
	memory: "component.memory-exceeded",
	timeout: "component.timeout",
} as const);

function outcomeOf(error: Error | ResolverComponentError): InvocationOutcome {
	if (error instanceof LimitTrap) {
		if (error.kind === "fuel") return InvocationOutcome.FUEL_EXHAUSTED;
		if (error.kind === "memory") return InvocationOutcome.MEMORY_EXCEEDED;
		return InvocationOutcome.TIMEOUT;
	}
	if (error instanceof AbiError) return InvocationOutcome.OUTPUT_UNPARSEABLE;
	if (error instanceof ResolverComponentError) {
		if (error.componentCode === "component.output-unparseable") return InvocationOutcome.OUTPUT_UNPARSEABLE;
		if (error.componentCode === "component.secret-exfiltration") return InvocationOutcome.SECRET_EXFILTRATION;
		if (error.componentCode === "component.egress-denied") return InvocationOutcome.EGRESS_DENIED;
		if (error.componentCode === "component.guest-rejected" || error.componentCode === "component.guest-unsupported")
			return InvocationOutcome.GUEST_ERROR;
	}
	return InvocationOutcome.TRAP;
}

function transportRequest(
	method: TransportMethod,
	url: URL,
	headers: Readonly<Record<string, string>>,
	body: string | null,
	call: CallState,
	maxResponseBytes: number,
	now: number,
): TransportRequest {
	const base: TransportRequest = {
		method,
		url: url.toString(),
		headers,
		timeoutMs: Math.max(1, call.meter.deadline - now),
		maxResponseBytes,
	};
	return body === null ? base : { ...base, body };
}

function canonicalClasses(classes: readonly ComponentClassLike[]): string {
	return JSON.stringify(
		[...classes]
			.map((entry) => ({
				productId: entry.productId,
				slot: entry.slot,
				retainedFields: [...new Set(entry.retainedFields)].sort(compare),
				observeFields: [...new Set(entry.observeFields)].sort(compare),
				directives: [...new Set(entry.directives)].sort(compare),
			}))
			.sort((left, right) => compare(left.productId, right.productId)),
	);
}

interface ComponentClassLike {
	readonly productId: string;
	readonly slot: string;
	readonly retainedFields: readonly string[];
	readonly observeFields: readonly string[];
	readonly directives: readonly string[];
}

/** A lowered `result::err` from the guest: an answer, not a trap. */
function isGuestError(value: JsonValue): boolean {
	return isJsonObject(value) && Object.hasOwn(value, "err");
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function errorMessage(error: Error): string {
	return error.message;
}

