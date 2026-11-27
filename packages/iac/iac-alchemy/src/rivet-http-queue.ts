/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: host capabilities cross a provider boundary and are captured before use. */
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
	createRivetMultiPoolPrimitiveMappers,
	type RivetPoolSource,
} from "./rivet-multi.js";
import {
	createRivetAsyncQueueClient,
	type RivetAsyncQueueTransport,
} from "./rivet-queue.js";
import {
	isRivetQueueBinding,
	type RivetQueueBinding,
} from "./rivet-queue-runtime.js";
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
const descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf;
const isArray = Array.isArray;
const apply = Reflect.apply;
const freeze = Object.freeze;
const arrayPrototype = Array.prototype;
const ownKeys = Reflect.ownKeys;
const defineProperty = Object.defineProperty;
const createNull = Object.create;
const nativeString = String;
const isSafeInteger = Number.isSafeInteger;
const NativeWeakMap = WeakMap;
const weakMapGet = NativeWeakMap.prototype.get;
const weakMapSet = NativeWeakMap.prototype.set;

function appendOwnData<Value>(items: Value[], value: Value): void {
	const property: PropertyDescriptor = createNull(null);
	property.value = value;
	property.enumerable = true;
	property.configurable = true;
	property.writable = true;
	defineProperty(items, nativeString(items.length), freeze(property));
}

export type RivetHttpQueueScope = RivetAsyncQueueTransport["scope"];
type QueueClient = ReturnType<typeof createRivetAsyncQueueClient>;

export interface RivetHttpQueueApplication {
	readonly http: RivetHttpBinding<RivetHttpEntrypoint>;
	readonly queue: RivetQueueBinding;
}

export interface RivetHttpQueueApplicationOptions {
	readonly actorName: string;
	readonly authorizationTimeoutMs?: number;
	readonly queue: RivetQueueBinding;
	readonly transport: RivetAsyncQueueTransport;

	readonly verifyScope: (
		claim: Readonly<{
			readonly httpActorName: string;
			readonly queue: RivetQueueBinding;
			readonly scope: RivetHttpQueueScope;
			readonly transport: RivetAsyncQueueTransport;
		}>,
	) => boolean;

	readonly authorize: (
		claim: RivetHttpRequestObservation & {
			readonly queue: RivetHttpQueueScope;
		},
	) => boolean | Promise<boolean>;

	readonly application: (
		client: QueueClient,
	) => (request: Request) => Response | Promise<Response>;
}

function own(input: unknown, key: string): unknown {
	if (typeof input !== "object" || input === null || isProxy(input))
		return undefined;
	const field = descriptor(input, key);
	return field !== undefined && hasOwn(field, "value") && field.enumerable
		? field.value
		: undefined;
}

function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function actorKey(value: unknown): readonly string[] | undefined {
	if (isProxy(value) || !isArray(value) || prototype(value) !== arrayPrototype)
		return undefined;
	const length = descriptor(value, "length");
	if (
		length === undefined ||
		!hasOwn(length, "value") ||
		!isSafeInteger(length.value) ||
		length.value < 1 ||
		length.value > 16 ||
		ownKeys(value).length !== length.value + 1
	)
		return undefined;
	const result: string[] = [];
	for (let index = 0; index < length.value; index++) {
		const item = descriptor(value, nativeString(index));
		if (
			item === undefined ||
			!hasOwn(item, "value") ||
			!item.enumerable ||
			!name(item.value)
		)
			return undefined;
		appendOwnData(result, item.value);
	}
	return freeze(result);
}

function captureTransport(
	input: unknown,
): RivetAsyncQueueTransport | undefined {
	try {
		const rawScope = own(input, "scope");
		if (
			typeof rawScope !== "object" ||
			rawScope === null ||
			isProxy(rawScope) ||
			ownKeys(rawScope).length !== 4
		)
			return undefined;
		const tenantId = own(rawScope, "tenantId");
		const instanceId = own(rawScope, "instanceId");
		const actorName = own(rawScope, "actorName");
		const key = actorKey(own(rawScope, "actorKey"));
		const fetch = own(input, "fetch");
		const verifyDispatch = own(input, "verifyDispatch");
		const boundsField =
			typeof input === "object" && input !== null && !isProxy(input)
				? descriptor(input, "verifyResponseBounds")
				: undefined;
		const bounds = own(input, "verifyResponseBounds");
		if (
			!name(tenantId) ||
			!name(instanceId) ||
			!name(actorName) ||
			key === undefined ||
			typeof fetch !== "function" ||
			isProxy(fetch) ||
			typeof verifyDispatch !== "function" ||
			isProxy(verifyDispatch) ||
			(boundsField !== undefined &&
				(!hasOwn(boundsField, "value") || !boundsField.enumerable)) ||
			(bounds !== undefined &&
				(typeof bounds !== "function" || isProxy(bounds)))
		)
			return undefined;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: each callback was captured from an own, non-Proxy function field.
		const captured = {
			scope: freeze({ tenantId, instanceId, actorName, actorKey: key }),
			fetch: fetch as RivetAsyncQueueTransport["fetch"],
			verifyDispatch:
				verifyDispatch as RivetAsyncQueueTransport["verifyDispatch"],
		};
		if (bounds === undefined) return freeze(captured);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the optional verifier was checked as an own, non-Proxy function.
		return freeze({
			...captured,
			verifyResponseBounds: bounds as NonNullable<
				RivetAsyncQueueTransport["verifyResponseBounds"]
			>,
		});
	} catch {
		return undefined;
	}
}

const applications = new NativeWeakMap<
	object,
	Readonly<{
		http: RivetHttpBinding<RivetHttpEntrypoint>;
		queue: RivetQueueBinding;
		verify: () => boolean;
	}>
>();

function matchesApplication(
	value: unknown,
): value is RivetHttpQueueApplication {
	try {
		if (typeof value !== "object" || value === null || isProxy(value))
			return false;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this private map stores only captured application records.
		const captured = apply(weakMapGet, applications, [value]) as
			| Readonly<{
					http: RivetHttpBinding<RivetHttpEntrypoint>;
					queue: RivetQueueBinding;
					verify: () => boolean;
			  }>
			| undefined;
		return (
			captured !== undefined &&
			own(value, "http") === captured.http &&
			own(value, "queue") === captured.queue &&
			isRivetHttpBinding(captured.http) &&
			isRivetQueueBinding(captured.queue) &&
			captured.verify()
		);
	} catch {
		return false;
	}
}

export function createRivetHttpQueueApplication(
	input: RivetHttpQueueApplicationOptions,
): RivetHttpQueueApplication {
	if (typeof input !== "object" || input === null || isProxy(input))
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"an application binding is required",
		);
	const actorName = own(input, "actorName");
	const queue = own(input, "queue");
	const transport = captureTransport(own(input, "transport"));
	const verifyScope = own(input, "verifyScope");
	const authorize = own(input, "authorize");
	const application = own(input, "application");
	const timeout = descriptor(input, "authorizationTimeoutMs");
	if (
		timeout !== undefined &&
		(!hasOwn(timeout, "value") ||
			(timeout.value !== undefined && typeof timeout.value !== "number"))
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"authorization timeout must be own numeric data",
		);
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the binding is checked as a non-Proxy object before its private brand is queried.
	if (
		!name(actorName) ||
		typeof queue !== "object" ||
		queue === null ||
		isProxy(queue) ||
		!isRivetQueueBinding(queue as RivetQueueBinding) ||
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
			"a branded queue, exact transport and host authorities are required",
		);
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the queue construction brand was checked above.
	const binding = queue as RivetQueueBinding;
	if (
		actorName === binding.actorName ||
		transport.scope.actorName !== binding.actorName
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			"the HTTP and queue actors must be distinct and the queue scope must match",
		);
	const scope = transport.scope;
	const claim = freeze({
		httpActorName: actorName,
		queue: binding,
		scope,
		transport,
	});
	const verify = () => {
		try {
			return (
				isRivetQueueBinding(binding) &&
				binding.actorName === scope.actorName &&
				isRivetSynchronousTrue(apply(verifyScope, undefined, [claim])) &&
				isRivetQueueBinding(binding)
			);
		} catch {
			return false;
		}
	};
	if (!verify())
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"the host did not verify the live queue scope and transport",
		);
	const client = createRivetAsyncQueueClient(transport);
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
				queue: scope,
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the application returned a synchronous non-Proxy function.
		return handler as (request: Request) => Response | Promise<Response>;
	};
	const http = createRivetHttpActor({
		actorName,
		entrypoint,
		verifyEntrypoint: verify,
		authorizationTimeoutMs:
			timeout?.value ?? RIVET_HTTP_AUTHORIZATION_TIMEOUT_MS,
		authorizationCoverage: "admission-and-response",
		authorize: permit,
	});
	const result = freeze({ http, queue: binding });
	apply(weakMapSet, applications, [
		result,
		freeze({ http, queue: binding, verify }),
	]);
	return result;
}

export interface RivetHttpQueuePoolClaim
	extends RivetPoolSource<RivetHttpEntrypoint> {
	readonly application: RivetHttpQueueApplication;
}
export interface RivetHttpQueueMapperOptions
	extends RivetPoolSource<RivetHttpEntrypoint> {
	readonly application: RivetHttpQueueApplication;

	readonly verifyPool: (claim: RivetHttpQueuePoolClaim) => boolean;
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
export type RivetHttpQueueMappers<Requirements> = Readonly<
	Record<"api" | "web" | "service" | "ui", HttpMapper<Requirements>>
>;

export function createRivetHttpQueueMappers<Requirements>(
	input: RivetHttpQueueMapperOptions,
): RivetHttpQueueMappers<Requirements> {
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
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the shared source reader validates the complete source and registry.
	const source = bindRivetHttpSource(
		sourceInput as RivetPoolSource<RivetHttpEntrypoint>["source"],
	);
	const matches = (entry: RivetPoolSource<RivetHttpEntrypoint>) => {
		try {
			if (
				!matchesApplication(application) ||
				entry.source.binding !== application.http ||
				entry.source.registry !== source.registry ||
				entry.source.actorName !== application.http.actorName ||
				entry.source.actorName === application.queue.actorName
			)
				return false;
			const registry = inspectRivetRegistry(source.registry);
			return (
				registry?.names.length === 2 &&
				registry.actor(application.http.actorName) === application.http.actor &&
				registry.actor(application.queue.actorName) === application.queue.actor
			);
		} catch {
			return false;
		}
	};
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the shared multi-pool mapper captures and validates the pool callbacks.
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
						apply(verifyPool, undefined, [freeze({ ...entry, application })]),
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
				const item = descriptor(prior, nativeString(index));
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
			"The colocated JSON queue is asynchronous and does not implement the HoBo synchronous Queue or WIT queue dependency.",
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
