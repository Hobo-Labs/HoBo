import { types } from "node:util";
import {
	type AnyActorDefinition,
	actor,
	isStaticActorDefinition,
} from "rivetkit";
import { createBoundaryDeferred } from "./async-boundary.js";
import { observeOrdinaryPromise } from "./node-promise-boundary.js";
import {
	createRivetHttpAuthorizationGate,
	RIVET_HTTP_AUTHORIZATION_TIMEOUT_MS,
	rivetHttpAuthorizationCurrent,
} from "./rivet-http-authorization.js";
import {
	type RivetHttpOutcomes,
	rivetCreateHttpNotStarted,
	rivetCreateHttpOutcomes,
	rivetIsResponse,
	rivetProtectResponse,
} from "./rivet-http-response.js";
import {
	createRivetHttpRetirementGate,
	type RivetHttpRetirement,
} from "./rivet-http-retirement.js";
import {
	isRivetAsyncResult,
	isRivetSynchronousTrue,
} from "./rivet-synchronous-authority.js";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters -- SAFETY: application entrypoints and context data cross the adapter's runtime boundary. */
export type RivetHttpEntrypoint = () => unknown;

export interface RivetRequestContext {
	readonly name: string;
	readonly key: readonly string[];

	readonly vars: object;
}

export interface RivetAuthorizationRequest {
	readonly method: string;
	readonly url: string;

	readonly headers: Headers;
}

export interface RivetHttpRequestObservation {
	readonly actorName: string;
	readonly actorKey: readonly string[];
	readonly request: RivetAuthorizationRequest;
}

export interface RivetHttpBinding<Entrypoint extends RivetHttpEntrypoint> {
	readonly actor: AnyActorDefinition;
	readonly actorName: string;
	readonly entrypoint: Entrypoint;
	readonly handle: (
		context: RivetRequestContext,
		request: Request,
	) => Promise<Response>;
}

const NativeWeakMap = WeakMap;
const weakGet = NativeWeakMap.prototype.get;
const weakSet = NativeWeakMap.prototype.set;
const bindings = new NativeWeakMap<
	object,
	Readonly<{
		createVars: () => object;
		onRequest: RivetHttpBinding<RivetHttpEntrypoint>["handle"];
		handle: RivetHttpBinding<RivetHttpEntrypoint>["handle"];
	}>
>();
const applyCaptured = Reflect.apply;
const isProxyCaptured = types.isProxy;
const isArrayCaptured = Array.isArray;
const arrayPrototype = Array.prototype;
const getPrototypeCaptured = Object.getPrototypeOf;
const descriptorCaptured = Object.getOwnPropertyDescriptor;
const hasOwnCaptured = Object.hasOwn;
const freezeCaptured = Object.freeze;
const keysCaptured = Object.keys;
const NativePromise = Promise;
const promiseResolve = NativePromise.resolve;
const NativeRequest = Request;
const NativeHeaders = Headers;
const requestPrototype = NativeRequest.prototype;
const requestSignal = descriptorCaptured(requestPrototype, "signal")?.get;
const signalPrototype = AbortSignal.prototype;
const signalAborted = descriptorCaptured(signalPrototype, "aborted")?.get;
const addListener = descriptorCaptured(
	EventTarget.prototype,
	"addEventListener",
)?.value;
const removeListener = descriptorCaptured(
	EventTarget.prototype,
	"removeEventListener",
)?.value;
const NativeAbortController = AbortController;
const controllerSignal = descriptorCaptured(
	NativeAbortController.prototype,
	"signal",
)?.get;
const controllerAbort = descriptorCaptured(
	NativeAbortController.prototype,
	"abort",
)?.value;
const requestFields = ["method", "url", "headers", "body", "signal"] as const;
const signalFields = [
	"aborted",
	"addEventListener",
	"removeEventListener",
] as const;

function immediateResponse(response: Response): Promise<Response> {
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the captured native resolver is called with the native constructor.
	return applyCaptured(promiseResolve, NativePromise, [
		response,
	]) as Promise<Response>;
}

function ownData(value: object, key: string): unknown {
	const descriptor = descriptorCaptured(value, key);
	return descriptor !== undefined && hasOwnCaptured(descriptor, "value")
		? descriptor.value
		: undefined;
}

function captureContext(context: unknown):
	| {
			readonly name: string;
			readonly key: readonly string[];
			readonly vars: object;
	  }
	| undefined {
	try {
		if (
			typeof context !== "object" ||
			context === null ||
			isProxyCaptured(context)
		)
			return undefined;
		const contextName = ownData(context, "name");
		const key = ownData(context, "key");
		const vars = ownData(context, "vars");
		if (
			typeof contextName !== "string" ||
			isProxyCaptured(key) ||
			!isArrayCaptured(key) ||
			getPrototypeCaptured(key) !== arrayPrototype ||
			typeof vars !== "object" ||
			vars === null ||
			isProxyCaptured(vars)
		)
			return undefined;
		const length = ownData(key, "length");
		if (
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 1 ||
			length > 16
		)
			return undefined;
		const parts: string[] = [];
		for (let index = 0; index < length; index++) {
			const field = descriptorCaptured(key, String(index));
			if (
				field === undefined ||
				!hasOwnCaptured(field, "value") ||
				!field.enumerable ||
				typeof field.value !== "string" ||
				!name(field.value)
			)
				return undefined;
			parts.push(field.value);
		}
		return { name: contextName, key: freezeCaptured(parts), vars };
	} catch {
		return undefined;
	}
}

function name(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

export function createRivetHttpActor<
	Entrypoint extends RivetHttpEntrypoint,
>(options: {
	readonly actorName: string;
	readonly entrypoint: Entrypoint;

	readonly authorizationTimeoutMs?: number;
	readonly authorizationCoverage?: "admission" | "admission-and-response";
	readonly authorize: (
		input: RivetHttpRequestObservation,
	) => boolean | Promise<boolean>;
	readonly verifyEntrypoint?: () => boolean;
}): RivetHttpBinding<Entrypoint> {
	const {
		actorName,
		entrypoint,
		authorize,
		verifyEntrypoint,
		authorizationTimeoutMs = RIVET_HTTP_AUTHORIZATION_TIMEOUT_MS,
		authorizationCoverage = "admission",
	} = options;
	if (
		!name(actorName) ||
		typeof entrypoint !== "function" ||
		typeof authorize !== "function" ||
		(authorizationCoverage !== "admission" &&
			authorizationCoverage !== "admission-and-response") ||
		(verifyEntrypoint !== undefined && typeof verifyEntrypoint !== "function")
	)
		throw new TypeError(
			"a named Rivet actor, application entrypoint and host authorization are required",
		);
	const authorization = createRivetHttpAuthorizationGate(
		authorizationTimeoutMs,
	);
	const createVars = () => ({});
	const applications = new NativeWeakMap<object, { readonly value: unknown }>();
	const reserveRetirement = createRivetHttpRetirementGate();
	const handleAdmitted = async (
		context: RivetRequestContext,
		request: Request,
		retirement: RivetHttpRetirement,
		outcomes: RivetHttpOutcomes,
		outcomeCurrent: () => boolean,
	): Promise<Response> => {
		const captured = captureContext(context);
		if (captured === undefined || captured.name !== actorName)
			return outcomes.forbidden;
		const { key: actorKey, vars } = captured;
		let applicationRequest: Request;
		let privateSignal: AbortSignal;
		let abortObserved = false;
		let transferAttempted = false;
		let listenerAttempted = false;
		try {
			if (
				typeof request !== "object" ||
				request === null ||
				isProxyCaptured(request) ||
				getPrototypeCaptured(request) !== requestPrototype ||
				requestFields.some(
					(field) => descriptorCaptured(request, field) !== undefined,
				) ||
				requestSignal === undefined ||
				signalAborted === undefined ||
				typeof addListener !== "function" ||
				typeof removeListener !== "function" ||
				controllerSignal === undefined ||
				typeof controllerAbort !== "function"
			)
				return outcomes.forbidden;
			const sourceSignal: unknown = applyCaptured(requestSignal, request, []);
			if (
				typeof sourceSignal !== "object" ||
				sourceSignal === null ||
				isProxyCaptured(sourceSignal) ||
				getPrototypeCaptured(sourceSignal) !== signalPrototype ||
				signalFields.some(
					(field) => descriptorCaptured(sourceSignal, field) !== undefined,
				)
			)
				return outcomes.forbidden;
			const controller = new NativeAbortController();
			const candidate: unknown = applyCaptured(
				controllerSignal,
				controller,
				[],
			);
			if (
				typeof candidate !== "object" ||
				candidate === null ||
				isProxyCaptured(candidate) ||
				getPrototypeCaptured(candidate) !== signalPrototype
			) {
				retirement.quarantine();
				return outcomes.forbidden;
			}
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the captured native getter returned an ordinary same-realm signal.
			privateSignal = candidate as AbortSignal;
			const relay = () => {
				abortObserved = true;
				try {
					applyCaptured(controllerAbort, controller, []);
					if (applyCaptured(signalAborted, privateSignal, []) !== true)
						retirement.quarantine();
				} catch {
					retirement.quarantine();
				}
			};
			retirement.onRelease(() => {
				applyCaptured(removeListener, sourceSignal, ["abort", relay]);
			});
			listenerAttempted = true;
			applyCaptured(addListener, sourceSignal, [
				"abort",
				relay,
				{ once: true },
			]);
			if (applyCaptured(signalAborted, sourceSignal, []) === true) relay();
			if (abortObserved) {
				applyCaptured(removeListener, sourceSignal, ["abort", relay]);
				listenerAttempted = false;
				retirement.onRelease(() => {});
				return outcomes.authorizationNotStarted;
			}

			transferAttempted = true;
			applicationRequest = new NativeRequest(request, {
				signal: privateSignal,
			});
		} catch {
			if (transferAttempted || listenerAttempted) retirement.quarantine();
			return outcomes.forbidden;
		}
		const refuse = (
			unavailable: boolean,
			execution: "not-started" | "possibly-completed" = "not-started",
		) => {
			retirement.request(applicationRequest);
			return unavailable
				? execution === "not-started"
					? outcomes.authorizationNotStarted
					: outcomes.authorizationPossiblyCompleted
				: outcomes.forbidden;
		};
		const applicationFailure = () => {
			retirement.request(applicationRequest);
			return outcomes.applicationPossiblyCompleted;
		};
		const requestIsCurrent = () => {
			try {
				return (
					outcomeCurrent() &&
					!abortObserved &&
					signalAborted !== undefined &&
					applyCaptured(signalAborted, privateSignal, []) === false
				);
			} catch {
				retirement.quarantine();
				return false;
			}
		};
		if (!requestIsCurrent()) return refuse(true);
		let originalRequest: RivetAuthorizationRequest;
		try {
			originalRequest = freezeCaptured({
				method: applicationRequest.method,
				url: applicationRequest.url,
				headers: new NativeHeaders(applicationRequest.headers),
			});
		} catch {
			return refuse(true);
		}
		const sourceCurrent = () => {
			try {
				return (
					verifyEntrypoint === undefined ||
					isRivetSynchronousTrue(verifyEntrypoint())
				);
			} catch {
				return false;
			}
		};
		const checkAuthorization = () =>
			authorization((current) => {
				if (
					!current() ||
					!requestIsCurrent() ||
					!sourceCurrent() ||
					!current() ||
					!requestIsCurrent()
				)
					throw new Error("Rivet HTTP source or request is unavailable");
				const snapshot = freezeCaptured({
					method: originalRequest.method,
					url: originalRequest.url,
					headers: new NativeHeaders(originalRequest.headers),
				});
				if (!current() || !requestIsCurrent())
					throw new Error("Rivet HTTP authorization deadline expired");
				return authorize({
					actorName,
					actorKey,
					request: snapshot,
				});
			});
		const allowed = (await checkAuthorization()).value;
		if (!requestIsCurrent() || !rivetHttpAuthorizationCurrent(allowed))
			return refuse(true);
		if (allowed.status === "deny") return refuse(false);
		if (allowed.status !== "allow") return refuse(true);
		const entrypointCurrent = (decision = allowed) => {
			if (!requestIsCurrent() || !rivetHttpAuthorizationCurrent(decision))
				return false;
			if (!sourceCurrent()) return false;
			return requestIsCurrent() && rivetHttpAuthorizationCurrent(decision);
		};
		let instance: { readonly value: unknown } | undefined = applyCaptured(
			weakGet,
			applications,
			[vars],
		);
		let applicationStarted = false;
		if (instance === undefined) {
			if (!entrypointCurrent()) return refuse(true);
			applicationStarted = true;
			try {
				const value = entrypoint();
				if (isRivetAsyncResult(value)) return applicationFailure();
				instance = { value };
			} catch {
				return applicationFailure();
			}
			if (!entrypointCurrent()) return refuse(true, "possibly-completed");
		}
		if (!requestIsCurrent() || !rivetHttpAuthorizationCurrent(allowed))
			return refuse(
				true,
				applicationStarted ? "possibly-completed" : "not-started",
			);
		const application = instance.value;
		let response: unknown;
		try {
			let raw: unknown;
			if (typeof application === "function") {
				if (!entrypointCurrent())
					return refuse(
						true,
						applicationStarted ? "possibly-completed" : "not-started",
					);
				if (applicationStarted)
					applyCaptured(weakSet, applications, [vars, instance]);
				raw = applyCaptured(application, undefined, [applicationRequest]);
			} else if (typeof application === "object" && application !== null) {
				if (!entrypointCurrent())
					return refuse(
						true,
						applicationStarted ? "possibly-completed" : "not-started",
					);
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: application is a non-null object; the captured value is checked below.
				const fetch: unknown = (application as { readonly fetch?: unknown })
					.fetch;
				if (!entrypointCurrent()) return refuse(true, "possibly-completed");
				if (typeof fetch !== "function") return applicationFailure();
				if (applicationStarted)
					applyCaptured(weakSet, applications, [vars, instance]);
				raw = applyCaptured(fetch, application, [applicationRequest]);
			} else return applicationFailure();
			if (rivetIsResponse(raw)) {
				if (!rivetProtectResponse(raw)) {
					retirement.quarantine();
					retirement.response(raw);
					return applicationFailure();
				}
				response = raw;
			} else {
				const settled = createBoundaryDeferred<unknown>();
				if (
					!observeOrdinaryPromise(
						raw,
						(value) => settled.resolve(value),
						() => settled.reject(undefined),
					)
				) {
					if (
						(typeof raw === "object" && raw !== null) ||
						typeof raw === "function"
					)
						retirement.quarantine();
					return applicationFailure();
				}
				response = (await settled.promise).value;
			}
			if (!rivetIsResponse(response)) {
				if (typeof response === "object" && response !== null)
					retirement.quarantine();
				return applicationFailure();
			}
			if (!rivetProtectResponse(response)) {
				retirement.quarantine();
				retirement.response(response);
				return applicationFailure();
			}
			if (!requestIsCurrent()) {
				retirement.response(response);
				return refuse(true, "possibly-completed");
			}
			if (authorizationCoverage === "admission-and-response") {
				const finalDecision = (await checkAuthorization()).value;
				if (
					finalDecision.status === "unavailable" ||
					!entrypointCurrent(finalDecision)
				) {
					retirement.response(response);
					return refuse(true, "possibly-completed");
				}
				if (finalDecision.status === "deny") {
					retirement.response(response);
					retirement.request(applicationRequest);
					return outcomes.authorizationDeniedPossiblyCompleted;
				}
			}
			retirement.retainSignal();
			return response;
		} catch {
			if (typeof response === "object" && response !== null)
				retirement.quarantine();
			return applicationFailure();
		}
	};
	const handlePrepared = async (
		context: RivetRequestContext,
		request: Request,
		retirement: RivetHttpRetirement,
		outcomes: RivetHttpOutcomes,
	): Promise<Response> => {
		let observationFailed = false;
		try {
			const pending = createBoundaryDeferred<Response>();
			const admitted = handleAdmitted(
				context,
				request,
				retirement,
				outcomes,
				() => !observationFailed,
			);
			if (
				!observeOrdinaryPromise(
					admitted,
					(value) => {
						if (rivetProtectResponse(value)) pending.resolve(value);
						else {
							retirement.quarantine();
							pending.resolve(outcomes.applicationPossiblyCompleted);
						}
					},
					() => {
						retirement.quarantine();
						pending.resolve(outcomes.applicationPossiblyCompleted);
					},
				)
			) {
				observationFailed = true;
				retirement.quarantine();
				return outcomes.authorizationNotStarted;
			}
			return (await pending.promise).value;
		} finally {
			retirement.finish();
		}
	};
	const handle: RivetHttpBinding<Entrypoint>["handle"] = (context, request) => {
		const retirement = reserveRetirement();
		if (retirement === undefined)
			return immediateResponse(rivetCreateHttpNotStarted());
		try {
			return handlePrepared(
				context,
				request,
				retirement,
				rivetCreateHttpOutcomes(),
			);
		} catch (error) {
			retirement.finish();
			throw error;
		}
	};

	const onRequest = (
		context: RivetRequestContext,
		request: Request,
	): Promise<Response> => {
		const retirement = reserveRetirement();
		if (retirement === undefined)
			return immediateResponse(rivetCreateHttpNotStarted());
		let outcomes: RivetHttpOutcomes;
		try {
			outcomes = rivetCreateHttpOutcomes();
		} catch (error) {
			retirement.finish();
			throw error;
		}
		try {
			if (
				typeof context !== "object" ||
				context === null ||
				isProxyCaptured(context)
			) {
				retirement.finish();
				return immediateResponse(outcomes.forbidden);
			}
			for (const key of ["name", "key", "vars"] as const) {
				const field = descriptorCaptured(context, key);
				if (field !== undefined && !hasOwnCaptured(field, "value")) {
					retirement.finish();
					return immediateResponse(outcomes.forbidden);
				}
			}
			return handlePrepared(
				{ name: context.name, key: context.key, vars: context.vars },
				request,
				retirement,
				outcomes,
			);
		} catch {
			retirement.finish();
			return immediateResponse(outcomes.forbidden);
		}
	};
	const definition = actor({ createVars, onRequest });
	freezeCaptured(definition.config.actions);
	freezeCaptured(definition.config.options);
	freezeCaptured(definition.config);
	freezeCaptured(definition);
	const binding: RivetHttpBinding<Entrypoint> = freezeCaptured({
		actor: definition,
		actorName,
		entrypoint,
		handle,
	});
	applyCaptured(weakSet, bindings, [
		binding,
		freezeCaptured({ createVars, onRequest, handle }),
	]);
	return binding;
}

export function isRivetHttpBinding(
	value: RivetHttpBinding<RivetHttpEntrypoint>,
): boolean {
	const captured:
		| {
				readonly createVars: () => object;
				readonly onRequest: RivetHttpBinding<RivetHttpEntrypoint>["handle"];
				readonly handle: RivetHttpBinding<RivetHttpEntrypoint>["handle"];
		  }
		| undefined = applyCaptured(weakGet, bindings, [value]);
	return (
		captured !== undefined &&
		isStaticActorDefinition(value.actor) &&
		"createVars" in value.actor.config &&
		value.actor.config.createVars === captured.createVars &&
		value.actor.config.onRequest === captured.onRequest &&
		value.handle === captured.handle &&
		keysCaptured(value.actor.config.actions ?? {}).length === 0
	);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters */
