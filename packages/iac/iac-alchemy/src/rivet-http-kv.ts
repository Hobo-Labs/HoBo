/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: caller-supplied provider and transport capabilities are checked before use. */
import { types } from "node:util";
import type { Providers } from "@alchemy.run/rivet";
import type {
	AlchemyPrimitiveInput,
	AlchemyPrimitiveMapper,
} from "./bindle.js";
import { AlchemyIacError } from "./plan.js";
import { bindRivetHttpSource } from "./rivet.js";
import { RIVET_HTTP_AUTHORIZATION_TIMEOUT_MS } from "./rivet-http-authorization.js";
import {
	createRivetAsyncKvClient,
	type RivetAsyncKvTransport,
} from "./rivet-kv.js";
import { kvActorName, kvDigest } from "./rivet-kv-protocol.js";
import {
	isRivetAsyncKvBinding,
	type RivetAsyncKvBinding,
} from "./rivet-kv-runtime.js";
import {
	createRivetMultiPoolPrimitiveMappers,
	type RivetPoolSource,
} from "./rivet-multi.js";
import {
	createRivetHttpActor,
	isRivetHttpBinding,
	type RivetHttpBinding,
	type RivetHttpEntrypoint,
	type RivetHttpRequestObservation,
} from "./rivet-runtime.js";
import { inspectRivetRegistry } from "./rivet-source-boundary.js";
import {
	isRivetAsyncResult,
	isRivetSynchronousTrue,
} from "./rivet-synchronous-authority.js";

const isProxy = types.isProxy;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const isArray = Array.isArray;
const arrayPrototype = Array.prototype;
const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const createNull = Object.create;
const defineProperty = Object.defineProperty;
const nativeString = String;
const isSafeInteger = Number.isSafeInteger;
const NativeWeakMap = WeakMap;
const weakMapGet = NativeWeakMap.prototype.get;
const weakMapSet = NativeWeakMap.prototype.set;

type KvClient = ReturnType<typeof createRivetAsyncKvClient>;

function appendOwnData<Value>(items: Value[], value: Value): void {
	const property: PropertyDescriptor = createNull(null);
	property.value = value;
	property.enumerable = true;
	property.configurable = true;
	property.writable = true;
	defineProperty(items, nativeString(items.length), freeze(property));
}

export interface RivetHttpKvScope {
	readonly actorName: string;
	readonly actorId: string;
	readonly actorKey: readonly string[];
	readonly semanticDigest: string;
}

export interface RivetHttpKvApplication {
	readonly http: RivetHttpBinding<RivetHttpEntrypoint>;
	readonly storage: RivetAsyncKvBinding;
}

export interface RivetHttpKvApplicationOptions {
	readonly actorName: string;

	readonly authorizationTimeoutMs?: number;
	readonly storage: RivetAsyncKvBinding;

	readonly transport: RivetAsyncKvTransport;

	readonly verifyScope: (
		claim: Readonly<{
			readonly httpActorName: string;
			readonly storage: RivetAsyncKvBinding;
			readonly scope: RivetHttpKvScope;
			readonly transport: RivetAsyncKvTransport;
		}>,
	) => boolean;

	readonly authorize: (
		claim: RivetHttpRequestObservation & {
			readonly storage: RivetHttpKvScope;
		},
	) => boolean | Promise<boolean>;

	readonly application: (
		client: KvClient,
	) => (request: Request) => Response | Promise<Response>;
}

function own(input: unknown, key: string): unknown {
	if (typeof input !== "object" || input === null || isProxy(input))
		return undefined;
	const field = getOwnDescriptor(input, key);
	return field !== undefined && hasOwn(field, "value") && field.enumerable
		? field.value
		: undefined;
}

function actorKey(input: unknown): readonly string[] | undefined {
	if (
		isProxy(input) ||
		!isArray(input) ||
		getPrototype(input) !== arrayPrototype
	)
		return undefined;
	const length = getOwnDescriptor(input, "length")?.value;
	if (
		!isSafeInteger(length) ||
		length < 1 ||
		length > 16 ||
		ownKeys(input).length !== length + 1
	)
		return undefined;
	const result: string[] = [];
	for (let index = 0; index < length; index++) {
		const field = getOwnDescriptor(input, nativeString(index));
		if (
			field === undefined ||
			!hasOwn(field, "value") ||
			!field.enumerable ||
			!kvActorName(field.value)
		)
			return undefined;
		appendOwnData(result, field.value);
	}
	return freeze(result);
}

function captureTransport(input: unknown): RivetAsyncKvTransport | undefined {
	try {
		const actorName = own(input, "actorName");
		const actorId = own(input, "actorId");
		const key = actorKey(own(input, "actorKey"));
		const semanticDigest = own(input, "semanticDigest");
		const fetch = own(input, "fetch");
		const verifyTransport = own(input, "verifyTransport");
		if (
			!kvActorName(actorName) ||
			!kvActorName(actorId) ||
			key === undefined ||
			!kvDigest(semanticDigest) ||
			typeof fetch !== "function" ||
			isProxy(fetch) ||
			typeof verifyTransport !== "function" ||
			isProxy(verifyTransport)
		)
			return undefined;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the transport functions were captured as own non-Proxy callbacks above.
		return freeze({
			actorName,
			actorId,
			actorKey: key,
			semanticDigest,
			fetch: fetch as RivetAsyncKvTransport["fetch"],
			verifyTransport:
				verifyTransport as RivetAsyncKvTransport["verifyTransport"],
		});
	} catch {
		return undefined;
	}
}

type CapturedApplication = Readonly<{
	http: RivetHttpBinding<RivetHttpEntrypoint>;
	storage: RivetAsyncKvBinding;
	verify: () => boolean;
}>;
const applications = new NativeWeakMap<object, CapturedApplication>();

function matchesApplication(value: unknown): value is RivetHttpKvApplication {
	try {
		if (typeof value !== "object" || value === null || isProxy(value))
			return false;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this private map contains only captured application records.
		const captured = apply(weakMapGet, applications, [value]) as
			| CapturedApplication
			| undefined;
		return (
			captured !== undefined &&
			own(value, "http") === captured.http &&
			own(value, "storage") === captured.storage &&
			isRivetHttpBinding(captured.http) &&
			isRivetAsyncKvBinding(captured.storage) &&
			captured.verify()
		);
	} catch {
		return false;
	}
}

function isStorageBinding(value: unknown): value is RivetAsyncKvBinding {
	if (typeof value !== "object" || value === null || isProxy(value))
		return false;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the runtime guard checks its private construction brand before reading actor fields.
	return isRivetAsyncKvBinding(value as RivetAsyncKvBinding);
}

export function createRivetHttpKvApplication(
	input: RivetHttpKvApplicationOptions,
): RivetHttpKvApplication {
	if (typeof input !== "object" || input === null || isProxy(input))
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"an application binding is required",
		);
	const actorName = own(input, "actorName");
	const storage = own(input, "storage");
	const transport = captureTransport(own(input, "transport"));
	const verifyScope = own(input, "verifyScope");
	const authorize = own(input, "authorize");
	const application = own(input, "application");
	const timeout = getOwnDescriptor(input, "authorizationTimeoutMs");
	if (
		timeout !== undefined &&
		(!hasOwn(timeout, "value") ||
			(timeout.value !== undefined && typeof timeout.value !== "number"))
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"authorization timeout must be own numeric data",
		);
	const authorizationTimeoutMs: number | undefined = timeout?.value;
	if (
		!kvActorName(actorName) ||
		!isStorageBinding(storage) ||
		transport === undefined ||
		typeof verifyScope !== "function" ||
		isProxy(verifyScope) ||
		typeof authorize !== "function" ||
		isProxy(authorize) ||
		typeof application !== "function" ||
		isProxy(application)
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"a branded storage actor, exact transport and host authorities are required",
		);
	const binding = storage;
	if (
		actorName === binding.actorName ||
		transport.actorName !== binding.actorName ||
		transport.semanticDigest !== binding.semanticDigest
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			"HTTP and storage actors must be distinct and the KV scope must match the storage actor",
		);
	const scope: RivetHttpKvScope = freeze({
		actorName: transport.actorName,
		actorId: transport.actorId,
		actorKey: transport.actorKey,
		semanticDigest: transport.semanticDigest,
	});
	const claim = freeze({
		httpActorName: actorName,
		storage: binding,
		scope,
		transport,
	});
	const verify = () => {
		try {
			return (
				isRivetAsyncKvBinding(binding) &&
				binding.actorName === transport.actorName &&
				binding.semanticDigest === transport.semanticDigest &&
				isRivetSynchronousTrue(apply(verifyScope, undefined, [claim])) &&
				isRivetAsyncKvBinding(binding)
			);
		} catch {
			return false;
		}
	};
	if (!verify())
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"the host did not verify the complete live KV scope and transport",
		);
	const client = createRivetAsyncKvClient(transport);

	const permit = (
		request: RivetHttpRequestObservation,
	): boolean | Promise<boolean> =>
		apply(authorize, undefined, [
			freeze({
				actorName: request.actorName,
				actorKey: request.actorKey,
				request: freeze({
					method: request.request.method,
					url: request.request.url,
					headers: request.request.headers,
				}),
				storage: scope,
			}),
		]);
	const entrypoint = () => {
		const handler: unknown = apply(application, undefined, [client]);
		if (
			isRivetAsyncResult(handler) ||
			typeof handler !== "function" ||
			isProxy(handler)
		)
			throw new TypeError(
				"the application must return a synchronous HTTP handler",
			);
		return handler;
	};
	const http = createRivetHttpActor({
		actorName,
		entrypoint,
		verifyEntrypoint: verify,
		authorizationTimeoutMs:
			authorizationTimeoutMs ?? RIVET_HTTP_AUTHORIZATION_TIMEOUT_MS,
		authorizationCoverage: "admission-and-response",
		authorize: permit,
	});
	const result: RivetHttpKvApplication = freeze({
		http,
		storage: binding,
	});
	apply(weakMapSet, applications, [
		result,
		freeze({ http, storage: binding, verify }),
	]);
	return result;
}

export interface RivetHttpKvPoolClaim
	extends RivetPoolSource<RivetHttpEntrypoint> {
	readonly application: RivetHttpKvApplication;
}
export interface RivetHttpKvMapperOptions
	extends RivetPoolSource<RivetHttpEntrypoint> {
	readonly application: RivetHttpKvApplication;

	readonly verifyPool: (claim: RivetHttpKvPoolClaim) => boolean;
}
type HttpMapper<Requirements> = AlchemyPrimitiveMapper<
	RivetHttpEntrypoint,
	Requirements,
	Providers
> & {
	readonly validate: (
		input: AlchemyPrimitiveInput<RivetHttpEntrypoint, Requirements>,
	) => void;
};
export type RivetHttpKvMappers<Requirements> = Readonly<
	Record<"api" | "web" | "service" | "ui", HttpMapper<Requirements>>
>;

export function createRivetHttpKvMappers<Requirements>(
	input: RivetHttpKvMapperOptions,
): RivetHttpKvMappers<Requirements> {
	const application = own(input, "application");
	const sourceInput = own(input, "source");
	const poolDigest = own(input, "poolDigest");
	const isolationDigest = own(input, "isolationDigest");
	const poolHost = own(input, "poolHost");
	const verifyPool = own(input, "verifyPool");
	if (
		!matchesApplication(application) ||
		typeof sourceInput !== "object" ||
		sourceInput === null ||
		typeof poolDigest !== "string" ||
		typeof isolationDigest !== "string" ||
		typeof poolHost !== "object" ||
		poolHost === null ||
		typeof verifyPool !== "function" ||
		isProxy(verifyPool)
	)
		throw new AlchemyIacError(
			"RIVET_POOL_UNVERIFIED",
			"the application and host pool must be verified",
		);
	const captured = application;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: source shape and the private registry are checked by bindRivetHttpSource.
	const source = bindRivetHttpSource(
		sourceInput as RivetPoolSource<RivetHttpEntrypoint>["source"],
	);
	const matches = (entry: RivetPoolSource<RivetHttpEntrypoint>) => {
		try {
			if (
				!matchesApplication(captured) ||
				entry.source.binding !== captured.http ||
				entry.source.registry !== source.registry ||
				entry.source.sourceFence.environmentDigest !==
					captured.storage.semanticDigest ||
				entry.source.actorName !== captured.http.actorName ||
				entry.source.actorName === captured.storage.actorName
			)
				return false;
			const registry = inspectRivetRegistry(source.registry);
			return (
				registry?.names.length === 2 &&
				registry.actor(captured.http.actorName) === captured.http.actor &&
				registry.actor(captured.storage.actorName) === captured.storage.actor
			);
		} catch {
			return false;
		}
	};
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the multi-pool builder validates and captures the host pool implementation.
	const mappers = createRivetMultiPoolPrimitiveMappers<
		RivetHttpEntrypoint,
		Requirements
	>(
		[
			{
				source,
				poolDigest,
				isolationDigest,
				poolHost: poolHost as RivetPoolSource<RivetHttpEntrypoint>["poolHost"],
			},
		],
		(entry) => {
			if (!matches(entry)) return false;
			try {
				return (
					isRivetSynchronousTrue(
						apply(verifyPool, undefined, [
							freeze({ ...entry, application: captured }),
						]),
					) && matches(entry)
				);
			} catch {
				return false;
			}
		},
	);
	const describe = (
		mapper: HttpMapper<Requirements>,
	): HttpMapper<Requirements> => {
		const limitations: string[] = [];
		const prior = mapper.limitations;
		if (prior !== undefined) {
			if (isProxy(prior) || !isArray(prior) || prior.length > 256)
				throw new AlchemyIacError(
					"RIVET_SOURCE_INVALID",
					"mapper limitations are invalid",
				);
			for (let index = 0; index < prior.length; index++) {
				const item = getOwnDescriptor(prior, nativeString(index));
				if (
					item === undefined ||
					!hasOwn(item, "value") ||
					typeof item.value !== "string"
				)
					throw new AlchemyIacError(
						"RIVET_SOURCE_INVALID",
						"mapper limitations are invalid",
					);
				appendOwnData(limitations, item.value);
			}
		}
		appendOwnData(
			limitations,
			"The colocated KV client is asynchronous and does not implement HoBo WASI or Bindle KV dependencies.",
		);
		return freeze({ ...mapper, limitations: freeze(limitations) });
	};
	return freeze({
		api: describe(mappers.api),
		web: describe(mappers.web),
		service: describe(mappers.service),
		ui: describe(mappers.ui),
	});
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */
