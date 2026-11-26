/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- Host capabilities cross a provider boundary. */
import { types } from "node:util";
import type { Providers } from "@alchemy.run/rivet";
import {
	AlchemyIacError,
	type AlchemyPrimitiveGraph,
	type AlchemyPrimitiveInput,
	type AlchemyPrimitiveMapper,
	type BindleForAlchemy,
	type PrimitiveDeclaration,
} from "@hobo/iac-alchemy";
import { bindRivetHttpSource } from "@hobo/iac-alchemy/rivet";
import {
	inspectRivetRegistry,
	isRivetAsyncResult,
	isRivetSynchronousTrue,
} from "@hobo/iac-alchemy/rivet/composition";
import {
	createRivetMultiPoolPrimitiveMappers,
	type RivetPoolSource,
} from "@hobo/iac-alchemy/rivet/multi";
import {
	createRivetHttpActor,
	isRivetHttpBinding,
	type RivetHttpBinding,
	type RivetHttpEntrypoint,
	type RivetHttpRequestObservation,
} from "@hobo/iac-alchemy/rivet/runtime";
import {
	type BindleTopicProvisionOperation,
	compileBindleTopicGrants,
	createBindleTopicPreparation,
	type createBindleTopicWitHost,
	type prepareBindleTopicWitHost,
} from "@hobo/runtime/durable-messaging-host";
import {
	createRivetDurableTopicClient,
	isRivetDurableTopicBusBinding,
	isRivetDurableTopicClientBoundTo,
	isRivetDurableTopicClientFor,
	RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	RIVET_DURABLE_TOPIC_BUS_LIMITS,
	type RivetDurableTopicBusBinding,
	type RivetDurableTopicClient,
	type RivetDurableTopicClientBinding,
	type RivetDurableTopicClientOptions,
} from "@hobo/runtime-rivet";
import * as Effect from "effect/Effect";

const isProxy = types.isProxy;
const apply = Reflect.apply;
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;

function invalid(message: string): never {
	throw new AlchemyIacError("RIVET_SOURCE_INVALID", message);
}

function fields(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		typeof input !== "object" ||
		input === null ||
		isProxy(input) ||
		Array.isArray(input)
	)
		return invalid("a bounded own-data record is required");
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null)
		return invalid("an own-data record is required");
	const keys = Reflect.ownKeys(input);
	if (
		keys.length > required.length + optional.length ||
		keys.some(
			(key) =>
				typeof key !== "string" ||
				(!required.includes(key) && !optional.includes(key)),
		)
	)
		return invalid("unexpected fields");
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string") return invalid("unexpected field");
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (
			!descriptor ||
			!Object.hasOwn(descriptor, "value") ||
			!descriptor.enumerable
		)
			return invalid("fields must be own data");
		result[key] = descriptor.value;
	}
	if (required.some((key) => !Object.hasOwn(result, key)))
		return invalid("a required field is missing");
	return result;
}

function actorKey(input: unknown): readonly string[] {
	if (
		isProxy(input) ||
		!Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Array.prototype
	)
		return invalid("the actor key must be a data array");
	const length = Object.getOwnPropertyDescriptor(input, "length");
	if (
		!length ||
		!Object.hasOwn(length, "value") ||
		!Number.isSafeInteger(length.value) ||
		length.value < 1 ||
		length.value > 16 ||
		Reflect.ownKeys(input).length !== length.value + 1
	)
		return invalid("the actor key is not bounded");
	const result: string[] = [];
	for (let i = 0; i < length.value; i++) {
		const item = Object.getOwnPropertyDescriptor(input, String(i));
		if (
			!item ||
			!Object.hasOwn(item, "value") ||
			!item.enumerable ||
			!name(item.value)
		)
			return invalid("the actor key must contain names");
		Object.defineProperty(result, String(i), {
			value: item.value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return Object.freeze(result);
}

function name(input: unknown): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		input.length <= 128 &&
		!/[\p{Cc}\uD800-\uDFFF]/u.test(input) &&
		new TextEncoder().encode(input).length <= 128
	);
}

function exactValues(
	input: unknown,
	expected: Readonly<Record<string, unknown>>,
): void {
	const keys = Object.keys(expected);
	const actual = fields(input, keys);
	for (const key of keys)
		if (actual[key] !== expected[key])
			invalid("the bus profile does not match");
}

function clientOptions(input: unknown): RivetDurableTopicClientOptions {
	const raw = fields(
		input,
		[
			"binding",
			"metadataGrant",
			"verifyTransport",
			"authorize",
			"revalidate",
			"fetch",
		],
		["timeoutMs", "maxInFlight"],
	);
	const binding = fields(raw.binding, [
		"actorName",
		"actorKey",
		"tenant",
		"instance",
		"semanticDigest",
		"limits",
		"actorCapabilities",
	]);
	if (
		!name(binding.actorName) ||
		!name(binding.tenant) ||
		!name(binding.instance) ||
		typeof binding.semanticDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(binding.semanticDigest)
	)
		return invalid("the bus identity is invalid");
	exactValues(binding.limits, RIVET_DURABLE_TOPIC_BUS_LIMITS);
	exactValues(binding.actorCapabilities, RIVET_DURABLE_TOPIC_BUS_CAPABILITIES);
	const scope = Object.freeze({
		actorName: binding.actorName,
		actorKey: actorKey(binding.actorKey),
		tenant: binding.tenant,
		instance: binding.instance,
		semanticDigest: binding.semanticDigest,
		limits: RIVET_DURABLE_TOPIC_BUS_LIMITS,
		actorCapabilities: RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	});
	if (
		typeof raw.metadataGrant !== "object" ||
		raw.metadataGrant === null ||
		isProxy(raw.metadataGrant) ||
		typeof raw.verifyTransport !== "function" ||
		isProxy(raw.verifyTransport) ||
		typeof raw.authorize !== "function" ||
		isProxy(raw.authorize) ||
		typeof raw.revalidate !== "function" ||
		isProxy(raw.revalidate) ||
		typeof raw.fetch !== "function" ||
		isProxy(raw.fetch) ||
		(raw.timeoutMs !== undefined &&
			(typeof raw.timeoutMs !== "number" ||
				!Number.isSafeInteger(raw.timeoutMs) ||
				raw.timeoutMs < 1 ||
				raw.timeoutMs > 300_000)) ||
		(raw.maxInFlight !== undefined &&
			(typeof raw.maxInFlight !== "number" ||
				!Number.isSafeInteger(raw.maxInFlight) ||
				raw.maxInFlight < 1 ||
				raw.maxInFlight > 128))
	)
		return invalid("the bus client callbacks and bounds are invalid");
	// SAFETY: the runtime validates the private metadata brand and each captured callback.
	const result: RivetDurableTopicClientOptions = {
		binding: scope,
		metadataGrant:
			raw.metadataGrant as RivetDurableTopicClientOptions["metadataGrant"],
		verifyTransport:
			raw.verifyTransport as RivetDurableTopicClientOptions["verifyTransport"],
		authorize: raw.authorize as RivetDurableTopicClientOptions["authorize"],
		revalidate: raw.revalidate as RivetDurableTopicClientOptions["revalidate"],
		fetch: raw.fetch as RivetDurableTopicClientOptions["fetch"],
	};
	if (typeof raw.timeoutMs === "number")
		Object.defineProperty(result, "timeoutMs", {
			value: raw.timeoutMs,
			enumerable: true,
		});
	if (typeof raw.maxInFlight === "number")
		Object.defineProperty(result, "maxInFlight", {
			value: raw.maxInFlight,
			enumerable: true,
		});
	return Object.freeze(result);
}

export type RivetHttpHandlerEntrypoint = () => (
	request: Request,
) => Response | Promise<Response>;

export interface RivetHttpTopicBusApplication {
	readonly http: RivetHttpBinding<RivetHttpHandlerEntrypoint>;
	readonly bus: RivetDurableTopicBusBinding;
	readonly client: RivetDurableTopicClient;
}

export interface RivetHttpTopicBusApplicationOptions {
	readonly actorName: string;
	readonly authorizationTimeoutMs?: number;
	readonly bus: RivetDurableTopicBusBinding;
	readonly clientOptions: RivetDurableTopicClientOptions;
	readonly verifyScope: (
		claim: Readonly<{
			httpActorName: string;
			bus: RivetDurableTopicBusBinding;
			client: RivetDurableTopicClient;
			clientOptions: RivetDurableTopicClientOptions;
		}>,
	) => boolean;
	readonly authorize: (
		claim: RivetHttpRequestObservation & {
			readonly bus: RivetDurableTopicClientBinding;
		},
	) => boolean | Promise<boolean>;
	readonly application: (
		client: RivetDurableTopicClient,
	) => (request: Request) => Response | Promise<Response>;
}

const applications = new WeakMap<
	object,
	Readonly<{
		http: RivetHttpBinding<RivetHttpHandlerEntrypoint>;
		bus: RivetDurableTopicBusBinding;
		client: RivetDurableTopicClient;
		verify: () => boolean;
	}>
>();
const bindleApplications = new WeakMap<
	object,
	Readonly<{
		bindleName: string;
		applicationName: string;
		grants: ReturnType<typeof compileBindleTopicGrants>;
	}>
>();

function matchesApplication(
	input: unknown,
): input is RivetHttpTopicBusApplication {
	try {
		if (typeof input !== "object" || input === null || isProxy(input))
			return false;
		const data = fields(input, ["http", "bus", "client"]);
		// SAFETY: the private map contains only application records created by this module.
		const captured = apply(weakGet, applications, [input]) as ReturnType<
			typeof applications.get
		>;
		return (
			captured !== undefined &&
			data.http === captured.http &&
			data.bus === captured.bus &&
			data.client === captured.client &&
			isRivetHttpBinding(captured.http) &&
			isRivetDurableTopicBusBinding(captured.bus) &&
			captured.verify()
		);
	} catch {
		return false;
	}
}

export function createRivetHttpTopicBusApplication(
	input: RivetHttpTopicBusApplicationOptions,
): RivetHttpTopicBusApplication {
	const data = fields(
		input,
		[
			"actorName",
			"bus",
			"clientOptions",
			"verifyScope",
			"authorize",
			"application",
		],
		["authorizationTimeoutMs"],
	);
	// SAFETY: the bus brand check refuses unregistered objects before accessing actor fields.
	if (
		!name(data.actorName) ||
		typeof data.bus !== "object" ||
		data.bus === null ||
		isProxy(data.bus) ||
		!isRivetDurableTopicBusBinding(data.bus as RivetDurableTopicBusBinding) ||
		typeof data.verifyScope !== "function" ||
		isProxy(data.verifyScope) ||
		typeof data.authorize !== "function" ||
		isProxy(data.authorize) ||
		typeof data.application !== "function" ||
		isProxy(data.application)
	)
		return invalid(
			"a branded bus, client options and host authorities are required",
		);
	// SAFETY: the preceding guard accepted the private bus brand.
	const bus = data.bus as RivetDurableTopicBusBinding;
	const expected = clientOptions(data.clientOptions);
	if (
		data.actorName === bus.actorName ||
		expected.binding.actorName !== bus.actorName ||
		expected.binding.semanticDigest !== bus.semanticDigest
	)
		return invalid("the HTTP actor and bus scope do not match");
	const client = createRivetDurableTopicClient(expected);
	const actorName = data.actorName;
	const verifyScope = data.verifyScope;
	const authorize = data.authorize;
	const application = data.application;
	const claim = Object.freeze({
		httpActorName: actorName,
		bus,
		client,
		clientOptions: expected,
	});
	const verify = () => {
		try {
			return (
				isRivetDurableTopicBusBinding(bus) &&
				isRivetDurableTopicClientFor(client, {
					actorName: bus.actorName,
					semanticDigest: bus.semanticDigest,
				}) &&
				isRivetDurableTopicClientBoundTo(client, expected) &&
				isRivetSynchronousTrue(apply(verifyScope, undefined, [claim])) &&
				isRivetDurableTopicBusBinding(bus) &&
				isRivetDurableTopicClientBoundTo(client, expected)
			);
		} catch {
			return false;
		}
	};
	if (!verify())
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"the host did not verify the bus client and scope",
		);
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
		// SAFETY: the host factory returned a synchronous non-proxy function.
		return handler as (request: Request) => Response | Promise<Response>;
	};
	const permit = (
		request: RivetHttpRequestObservation,
	): boolean | Promise<boolean> =>
		apply(authorize, undefined, [
			Object.freeze({
				actorName: request.actorName,
				actorKey: request.actorKey,
				request: Object.freeze({
					method: request.request.method,
					url: request.request.url,
					headers: request.request.headers,
				}),
				bus: expected.binding,
			}),
		]);
	const httpOptions = {
		actorName,
		entrypoint,
		verifyEntrypoint: verify,
		authorizationCoverage: "admission-and-response" as const,
		authorize: permit,
	};
	if (data.authorizationTimeoutMs !== undefined) {
		if (typeof data.authorizationTimeoutMs !== "number")
			return invalid("the authorization timeout must be a number");
		Object.defineProperty(httpOptions, "authorizationTimeoutMs", {
			value: data.authorizationTimeoutMs,
			enumerable: true,
		});
	}
	const http = createRivetHttpActor(httpOptions);
	const result = Object.freeze({ http, bus, client });
	apply(weakSet, applications, [
		result,
		Object.freeze({ http, bus, client, verify }),
	]);
	return result;
}

export interface RivetBindleTopicBusApplicationOptions
	extends Omit<RivetHttpTopicBusApplicationOptions, "application"> {
	readonly bindle: Parameters<typeof createBindleTopicWitHost>[1];
	readonly operations: readonly BindleTopicProvisionOperation[];
	readonly hostOptions: (
		client: RivetDurableTopicClient,
	) => Parameters<typeof prepareBindleTopicWitHost>[3];
	readonly application: (
		host: ReturnType<typeof createBindleTopicWitHost>,
	) => (request: Request) => Response | Promise<Response>;
}

/** Start application logic only after the declared journals are confirmed. */
export function createRivetBindleTopicBusApplication(
	input: RivetBindleTopicBusApplicationOptions,
): RivetHttpTopicBusApplication {
	const data = fields(
		input,
		[
			"actorName",
			"bus",
			"clientOptions",
			"verifyScope",
			"authorize",
			"bindle",
			"operations",
			"hostOptions",
			"application",
		],
		["authorizationTimeoutMs"],
	);
	if (
		typeof data.hostOptions !== "function" ||
		isProxy(data.hostOptions) ||
		typeof data.application !== "function" ||
		isProxy(data.application)
	)
		return invalid("the application and topic host factory are required");
	const hostOptions = data.hostOptions;
	const application = data.application;
	let prepare: ReturnType<typeof createBindleTopicPreparation>;
	const baseOptions = {
		actorName: data.actorName,
		bus: data.bus,
		clientOptions: data.clientOptions,
		verifyScope: data.verifyScope,
		authorize: data.authorize,
		application: () => {
			let handler:
				| ((request: Request) => Response | Promise<Response>)
				| undefined;
			return async (request: Request) => {
				const result = await prepare();
				if (result.status !== "ready") {
					const failure = result.provisioning;
					return Response.json(
						{
							status: "topic-unavailable",
							reason:
								failure.status === "incomplete"
									? failure.outcome.tag
									: failure.status,
						},
						{ status: 503 },
					);
				}
				if (!matchesApplication(bound))
					return Response.json(
						{ status: "topic-unavailable", reason: "scope-unverified" },
						{ status: 503 },
					);
				if (handler === undefined) {
					const candidate: unknown = apply(application, undefined, [
						result.application,
					]);
					if (
						isRivetAsyncResult(candidate) ||
						typeof candidate !== "function" ||
						isProxy(candidate)
					)
						return invalid(
							"the application must return a synchronous HTTP handler",
						);
					// SAFETY: the host returned a synchronous non-proxy handler.
					handler = candidate as (
						request: Request,
					) => Response | Promise<Response>;
				}
				if (!matchesApplication(bound))
					return Response.json(
						{ status: "topic-unavailable", reason: "scope-unverified" },
						{ status: 503 },
					);
				return handler(request);
			};
		},
	};
	if (data.authorizationTimeoutMs !== undefined)
		Object.defineProperty(baseOptions, "authorizationTimeoutMs", {
			value: data.authorizationTimeoutMs,
			enumerable: true,
		});
	// SAFETY: the underlying adapter validates each captured field and callback.
	const bound = createRivetHttpTopicBusApplication(
		baseOptions as RivetHttpTopicBusApplicationOptions,
	);
	const options: unknown = apply(hostOptions, undefined, [bound.client]);
	if (isRivetAsyncResult(options))
		return invalid("the topic host factory must be synchronous");
	// SAFETY: preparation validates the captured graph, operations, and host options.
	prepare = createBindleTopicPreparation(
		bound.client,
		data.bindle as Parameters<typeof createBindleTopicWitHost>[1],
		data.operations as readonly BindleTopicProvisionOperation[],
		options as Parameters<typeof prepareBindleTopicWitHost>[3],
	);
	const graph = fields(data.bindle, [
		"bindleName",
		"applicationName",
		"resources",
		"edges",
		"bindings",
	]);
	if (!name(graph.bindleName) || !name(graph.applicationName))
		return invalid("the Bindle identity is invalid");
	// SAFETY: the compiler validates and snapshots the Bindle graph.
	const grants = compileBindleTopicGrants({
		applicationName: graph.applicationName,
		resources: graph.resources,
		edges: graph.edges,
		bindings: graph.bindings,
	} as Parameters<typeof compileBindleTopicGrants>[0]);
	apply(weakSet, bindleApplications, [
		bound,
		Object.freeze({
			bindleName: graph.bindleName,
			applicationName: graph.applicationName,
			grants,
		}),
	]);
	return bound;
}

/** Attach the captured HTTP entrypoint without rebuilding the Bindle graph. */
export function bindRivetBindleTopicEntrypoint<Requirements>(
	bindle: BindleForAlchemy<RivetHttpEntrypoint, Requirements>,
	application: RivetHttpTopicBusApplication,
): BindleForAlchemy<RivetHttpEntrypoint, Requirements> {
	if (
		typeof bindle !== "object" ||
		bindle === null ||
		isProxy(bindle) ||
		!matchesApplication(application)
	)
		return invalid("a verified application and Bindle are required");
	// SAFETY: only applications created by the Bindle adapter have an entry here.
	const captured = apply(weakGet, bindleApplications, [
		application,
	]) as ReturnType<typeof bindleApplications.get>;
	if (captured === undefined)
		return invalid("the application has no Bindle topic host");
	const property = (key: string, required = true): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(bindle, key);
		if (descriptor === undefined && !required) return undefined;
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
			return invalid("Bindle fields must be own data");
		return descriptor.value;
	};
	const nameValue = property("name");
	const resources = property("resources");
	const edges = property("edges");
	const requirements = property("requirements");
	const connectors = property("connectors", false);
	const entrypoint = property("entrypoint");
	if (
		nameValue !== captured.bindleName ||
		typeof entrypoint !== "function" ||
		isProxy(entrypoint)
	)
		return invalid("the Bindle identity or entrypoint resolver is invalid");
	const previous: unknown = apply(entrypoint, bindle, [
		captured.applicationName,
	]);
	if (
		isRivetAsyncResult(previous) ||
		(previous !== undefined && previous !== application.http.entrypoint)
	)
		return invalid("the application already has a different entrypoint");
	const result = {
		name: nameValue,
		resources,
		edges,
		requirements,
		entrypoint: (name: string) =>
			name === captured.applicationName
				? application.http.entrypoint
				: apply(entrypoint, bindle, [name]),
	};
	if (connectors !== undefined)
		Object.defineProperty(result, "connectors", {
			value: connectors,
			enumerable: true,
		});
	if (!matchesApplication(application))
		return invalid("the application is no longer verified");
	// SAFETY: the Alchemy Bindle mapper validates and snapshots the captured graph before use.
	return Object.freeze(result) as BindleForAlchemy<
		RivetHttpEntrypoint,
		Requirements
	>;
}

export interface RivetHttpTopicBusPoolClaim
	extends RivetPoolSource<RivetHttpEntrypoint> {
	readonly application: RivetHttpTopicBusApplication;
}
export interface RivetHttpTopicBusMapperOptions
	extends RivetPoolSource<RivetHttpEntrypoint> {
	readonly application: RivetHttpTopicBusApplication;
	readonly verifyPool: (claim: RivetHttpTopicBusPoolClaim) => boolean;
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
export type RivetHttpTopicBusMappers<Requirements> = Readonly<
	Record<"api" | "web" | "service", HttpMapper<Requirements>>
>;

export function createRivetHttpTopicBusMappers<Requirements>(
	input: RivetHttpTopicBusMapperOptions,
): RivetHttpTopicBusMappers<Requirements> {
	const data = fields(input, [
		"application",
		"source",
		"poolDigest",
		"isolationDigest",
		"poolHost",
		"verifyPool",
	]);
	if (
		!matchesApplication(data.application) ||
		typeof data.verifyPool !== "function" ||
		isProxy(data.verifyPool) ||
		typeof data.poolDigest !== "string" ||
		typeof data.isolationDigest !== "string" ||
		typeof data.poolHost !== "object" ||
		data.poolHost === null ||
		isProxy(data.poolHost)
	)
		throw new AlchemyIacError(
			"RIVET_POOL_UNVERIFIED",
			"a verified application and pool are required",
		);
	const application = data.application;
	// SAFETY: the source parser validates and snapshots this external value.
	const source = bindRivetHttpSource(
		data.source as RivetPoolSource<RivetHttpEntrypoint>["source"],
	);
	// SAFETY: the multi-pool mapper validates the host capability before use.
	const pool = Object.freeze({
		source,
		poolDigest: data.poolDigest,
		isolationDigest: data.isolationDigest,
		poolHost: data.poolHost as RivetPoolSource<RivetHttpEntrypoint>["poolHost"],
	});
	const verifyPool = data.verifyPool;
	const matches = (entry: RivetPoolSource<RivetHttpEntrypoint>) => {
		try {
			const registry = inspectRivetRegistry(source.registry);
			return (
				matchesApplication(application) &&
				entry.source.binding === application.http &&
				entry.source.registry === source.registry &&
				entry.source.actorName === application.http.actorName &&
				entry.source.sourceFence.environmentDigest ===
					application.bus.semanticDigest &&
				registry?.names.length === 2 &&
				registry.actor(application.http.actorName) === application.http.actor &&
				registry.actor(application.bus.actorName) === application.bus.actor
			);
		} catch {
			return false;
		}
	};
	const mappers = createRivetMultiPoolPrimitiveMappers<
		RivetHttpEntrypoint,
		Requirements
	>([pool], (entry) => {
		if (!matches(entry)) return false;
		try {
			return (
				isRivetSynchronousTrue(
					apply(verifyPool, undefined, [
						Object.freeze({ ...entry, application }),
					]),
				) && matches(entry)
			);
		} catch {
			return false;
		}
	});
	const describe = (
		mapper: HttpMapper<Requirements>,
	): HttpMapper<Requirements> => {
		const prior = mapper.limitations ?? [];
		if (isProxy(prior) || !Array.isArray(prior) || prior.length > 256)
			return invalid("mapper limitations are invalid");
		const limits: string[] = [];
		for (let i = 0; i < prior.length; i++) {
			const item = Object.getOwnPropertyDescriptor(prior, String(i));
			if (
				!item ||
				!Object.hasOwn(item, "value") ||
				typeof item.value !== "string"
			)
				return invalid("mapper limitations are invalid");
			Object.defineProperty(limits, String(i), {
				value: item.value,
				writable: true,
				configurable: true,
				enumerable: true,
			});
		}
		Object.defineProperty(limits, String(limits.length), {
			value:
				"The colocated durable bus is asynchronous; Bindle topic and WIT queue dependencies are not mapped by this composition.",
			writable: true,
			configurable: true,
			enumerable: true,
		});
		return Object.freeze({ ...mapper, limitations: Object.freeze(limits) });
	};
	return Object.freeze({
		api: describe(mappers.api),
		web: describe(mappers.web),
		service: describe(mappers.service),
	});
}

/** Map one HTTP application and its named topics onto its verified Rivet pool. */
export function createRivetBindleTopicBusMappers<Requirements>(
	input: RivetHttpTopicBusMapperOptions,
): Readonly<
	Record<
		"api" | "web" | "service" | "topic",
		AlchemyPrimitiveMapper<RivetHttpEntrypoint, Requirements, Providers>
	>
> {
	const data = fields(input, [
		"application",
		"source",
		"poolDigest",
		"isolationDigest",
		"poolHost",
		"verifyPool",
	]);
	// SAFETY: the source parser validates and captures every field before invoking its verifier.
	const source = bindRivetHttpSource(
		data.source as RivetHttpTopicBusMapperOptions["source"],
	);
	const optionsRaw: unknown = Object.freeze({ ...data, source });
	// SAFETY: the base mapper validates the captured application, pool and callback.
	const options = optionsRaw as RivetHttpTopicBusMapperOptions;
	const base = createRivetHttpTopicBusMappers<Requirements>(options);
	const application = options.application;
	// SAFETY: only applications created by the Bindle adapter have an entry here.
	const captured = apply(weakGet, bindleApplications, [
		application,
	]) as ReturnType<typeof bindleApplications.get>;
	if (
		captured === undefined ||
		captured.grants.length === 0 ||
		source.resourceName !== captured.applicationName
	)
		return invalid("a Bindle application with named topics is required");
	const names = captured.grants.map((grant) => grant.resourceName).sort();
	const sourceKind = source.kind;
	const owner = names[0];
	if (owner === undefined) return invalid("a topic owner is required");
	const matchesNames = (
		actual: readonly string[],
		expected: readonly string[],
	) =>
		actual.length === expected.length &&
		[...actual].sort().every((name, index) => name === expected[index]);
	const validateGraph = (graph: AlchemyPrimitiveGraph<Requirements>) => {
		if (
			!matchesApplication(application) ||
			graph.bindleName !== captured.bindleName
		)
			return invalid("the Bindle topic application is no longer verified");
		const app = graph.nodes[captured.applicationName];
		if (
			app === undefined ||
			app.declaration.kind !== sourceKind ||
			!matchesNames(app.dependencies, names)
		)
			return invalid(
				"the application topic graph does not match the bound runtime",
			);
		const declaredTopics = Object.entries(graph.nodes)
			.filter(([, row]) => row.declaration.kind === "topic")
			.map(([key]) => key)
			.sort();
		if (!matchesNames(declaredTopics, names))
			return invalid("the topic declarations do not match the bound runtime");
		for (const { resourceName, grant } of captured.grants) {
			const topic = graph.nodes[resourceName];
			const allowed = [
				...(grant.publish ? ["publish"] : []),
				...(grant.subscriptions.length ? ["subscribe"] : []),
			].sort();
			if (
				topic === undefined ||
				topic.dependencies.length !== 0 ||
				topic.declaration.annotations.length !== 0 ||
				!matchesNames(topic.declaration.declaredAllow, allowed)
			)
				return invalid("a topic declaration does not match its runtime grant");
		}
		for (const [key, row] of Object.entries(graph.nodes))
			if (
				key !== captured.applicationName &&
				row.dependencies.some((dependency) => names.includes(dependency))
			)
				return invalid("a topic is bound to another application");
	};
	const withoutDependencies = (
		input: AlchemyPrimitiveInput<RivetHttpEntrypoint, Requirements>,
	) => ({
		...input,
		declaration: { ...input.declaration, dependsOn: [] },
		dependencyDeclarations: Object.freeze({}),
	});
	const appMapper = (
		kind: "api" | "web" | "service",
	): AlchemyPrimitiveMapper<RivetHttpEntrypoint, Requirements, Providers> =>
		Object.freeze<
			AlchemyPrimitiveMapper<RivetHttpEntrypoint, Requirements, Providers>
		>({
			resourceTypes: Object.freeze(["Rivet.DurableObject"]),
			operations: base[kind].operations,
			annotations: base[kind].annotations,
			bindsEntrypoint: true,
			limitations: Object.freeze([
				"Only the captured application and its named asynchronous topics are bound; other dependencies require a separate mapping.",
			]),
			validateGraph,
			validate: (input) => base[kind].validate(withoutDependencies(input)),
			build: (input) => {
				base[kind].validate(withoutDependencies(input));
				const primary = input.dependencies[owner];
				if (primary === undefined)
					return invalid("the shared topic resource is missing");
				return Effect.succeed({
					primary,
					resources: [],
					sharedDependency: owner,
					boundDependencies: [...names],
					boundEntrypoint: application.http.entrypoint,
				});
			},
		});
	const topic: AlchemyPrimitiveMapper<
		RivetHttpEntrypoint,
		Requirements,
		Providers
	> = Object.freeze<
		AlchemyPrimitiveMapper<RivetHttpEntrypoint, Requirements, Providers>
	>({
		resourceTypes: Object.freeze(["Rivet.DurableObject"]),
		operations: Object.freeze(["publish", "subscribe"]),
		annotations: Object.freeze([]),
		bindsEntrypoint: false,
		validateGraph,
		limitations: Object.freeze([
			"Named asynchronous topics share the application's verified Rivet durable bus; journals are provisioned at application startup.",
		]),
		build: (input) => {
			if (!names.includes(input.declaration.name))
				return invalid("the topic was not captured by the application");
			if (input.declaration.name !== owner) {
				const primary = input.priorPrimitives?.[owner];
				if (primary === undefined)
					return invalid("the shared topic owner is missing");
				return Effect.succeed({
					primary,
					resources: [],
					sharedPrimitive: owner,
					boundDependencies: [],
				});
			}
			const declaration: PrimitiveDeclaration = {
				kind: sourceKind,
				name: captured.applicationName,
				stableId: `${sourceKind}:${captured.applicationName}`,
				declaredAllow: [],
				dependsOn: [],
				annotations: [],
			};
			return base[sourceKind]
				.build({
					bindleName: input.bindleName,
					requirements: input.requirements,
					declaration,
					entrypoint: application.http.entrypoint,
					dependencyDeclarations: {},
					dependencies: {},
				})
				.pipe(
					Effect.map((mapped) => ({
						primary: mapped.primary,
						resources: mapped.resources,
						boundDependencies: [],
					})),
				);
		},
	});
	return Object.freeze({
		api: appMapper("api"),
		web: appMapper("web"),
		service: appMapper("service"),
		topic,
	});
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */
