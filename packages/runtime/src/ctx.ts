// `ctx` — the capability/effect context handed to every durable handler
// (sdk-api.md §Layer 4). It is the deny-by-default membrane: durability
// primitives (`step`, `sleep`, `emit`, deterministic `now`/`random`) are always
// available, but *effectful* capabilities — reaching another actor, minting a
// broker token, invoking an agent tool — are granted only when the handler's
// definition declared them. An undeclared reach throws `CapabilityDeniedError`,
// mirroring the WASI capability sandbox (wasm-runtime-wit.md §Security substrate)
// where an un-linked interface simply has no route.

import { CapabilityDeniedError } from "./errors.js";
import type { JsonValue } from "./json.js";
import type { WitTokenHandle, WitTokenRequest } from "./wit.js";

/**
 * A declared capability. Effect capabilities are namespaced:
 *   - `tool:<name>`      — invoke agent tool `<name>`
 *   - `token:<provider>` — mint a broker token for `<provider>`
 *   - `actor`            — signal/read another actor
 */
export type Capability = string;

export function toolCapability(name: string): Capability {
	return `tool:${name}`;
}

export function tokenCapability(provider: string): Capability {
	return `token:${provider}`;
}

/** A durable step's options (lowers onto `hobo:runtime` `step-opts`). */
export interface StepOptions {
	retries?: number;
	timeoutMs?: number;
	idempotencyKey?: string;
}

/** A stub over another actor, reached through `ctx.actor(...)` (capability `actor`). */
export interface ActorStub {
	readonly key: string;
	signal(message: { type: string; [key: string]: JsonValue }): Promise<number>;
	state<S = JsonValue>(): Promise<S>;
}

/** Broker token seam (`ctx.token`, capability `token:<provider>`). */
export type TokenBroker = (request: WitTokenRequest) => WitTokenHandle;

/** The effect implementations the engine wires into a context. */
export interface CtxEffects {
	step<T>(
		name: string,
		fn: () => Promise<T> | T,
		opts?: StepOptions,
	): Promise<T>;
	sleep(durationMs: number, options?: { label?: string }): Promise<void>;
	emit(type: string, data?: JsonValue): Promise<number>;
	now(): string;
	random(label?: string): number;
	actor?(ref: { typeName: string; key: string }): ActorStub;
	token?: TokenBroker;
	tool?(name: string, input: JsonValue): Promise<JsonValue>;
}

/**
 * The context surface seen by workflow/agent handlers. `capabilities` is the
 * declared grant; `requireCapability` is the membrane check the effectful
 * methods run before delegating.
 */
export interface RuntimeContext {
	readonly capabilities: ReadonlySet<Capability>;
	requireCapability(capability: Capability): void;
	step<T>(
		name: string,
		fn: () => Promise<T> | T,
		opts?: StepOptions,
	): Promise<T>;
	sleep(durationMs: number, options?: { label?: string }): Promise<void>;
	emit(type: string, data?: JsonValue): Promise<number>;
	now(): string;
	random(label?: string): number;
	actor(ref: { typeName: string; key: string }): ActorStub;
	token(request: WitTokenRequest): WitTokenHandle;
	tool(name: string, input: JsonValue): Promise<JsonValue>;
}

/**
 * Build the deny-by-default effect context. Durability primitives pass through;
 * `actor`/`token`/`tool` first assert the matching capability, then delegate to
 * the injected effect — or throw if the engine wired no implementation.
 */
export function createRuntimeContext(input: {
	capabilities: Iterable<Capability>;
	effects: CtxEffects;
}): RuntimeContext {
	const capabilities = new Set(input.capabilities);
	const effects = input.effects;

	const requireCapability = (capability: Capability): void => {
		if (!capabilities.has(capability)) {
			throw new CapabilityDeniedError(capability, [...capabilities]);
		}
	};

	return Object.freeze({
		// SAFETY: assertion to `ReadonlySet<Capability>, requireCapab` is required at this boundary.
		capabilities: capabilities as ReadonlySet<Capability>,
		requireCapability,
		step: effects.step,
		sleep: effects.sleep,
		emit: effects.emit,
		now: effects.now,
		random: effects.random,
		actor(ref: { typeName: string; key: string }): ActorStub {
			requireCapability("actor");
			if (!effects.actor) {
				throw new CapabilityDeniedError("actor", [...capabilities]);
			}
			return effects.actor(ref);
		},
		token(request: WitTokenRequest): WitTokenHandle {
			requireCapability(tokenCapability(request.provider));
			if (!effects.token) {
				throw new CapabilityDeniedError(tokenCapability(request.provider), [
					...capabilities,
				]);
			}
			return effects.token(request);
		},
		async tool(name: string, toolInput: JsonValue): Promise<JsonValue> {
			requireCapability(toolCapability(name));
			if (!effects.tool) {
				throw new CapabilityDeniedError(toolCapability(name), [
					...capabilities,
				]);
			}
			return effects.tool(name, toolInput);
		},
	});
}
