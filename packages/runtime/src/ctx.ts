import { CapabilityDeniedError } from "./errors.js";
import type { JsonValue } from "./json.js";
import type { WitTokenHandle, WitTokenRequest } from "./wit.js";

export type Capability = string;

export function toolCapability(name: string): Capability {
	return `tool:${name}`;
}

export function tokenCapability(provider: string): Capability {
	return `token:${provider}`;
}

export interface StepOptions {
	retries?: number;
	timeoutMs?: number;
	idempotencyKey?: string;
}

export interface ActorStub {
	readonly key: string;
	signal(message: { type: string; [key: string]: JsonValue }): Promise<number>;
	state<S = JsonValue>(): Promise<S>;
}

export type TokenBroker = (request: WitTokenRequest) => WitTokenHandle;

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
