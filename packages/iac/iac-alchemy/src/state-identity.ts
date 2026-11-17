import type { StackPlan } from "alchemy/Alchemist";
import { decodeFqn, encodeFqn } from "alchemy/FQN";
import type * as Stack from "alchemy/Stack";
import { State, type StateService, StateStoreError } from "alchemy/State";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

/** Names used as LocalState directories and BucketState prefix segments. */
export function safeAlchemyStateSegment(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) &&
		!value.endsWith(".") &&
		!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
	);
}

/** Canonical registry key for hosts assigning distinct physical stack/stage scopes. */
export function alchemyStateScopeKey(stack: string, stage: string): string {
	if (!safeAlchemyStateSegment(stack) || !safeAlchemyStateSegment(stage))
		throw new Error(
			"STATE_IDENTITY_INVALID: stack and stage must be safe path segments",
		);
	return `${stack.toLowerCase()}/${stage.toLowerCase()}`;
}

/** Only round-tripping identities can be used with Alchemy's file/object stores. */
export function safeAlchemyFqn(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.split("/").every(safeAlchemyStateSegment) &&
		decodeFqn(encodeFqn(value)) === value &&
		!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(encodeFqn(value))
	);
}

/** Guard case-insensitive stores as well as Alchemy's FQN encoding. */
export function uniqueAlchemyFqns(values: readonly string[]): boolean {
	return (
		new Set(values.map((value) => encodeFqn(value).toLowerCase())).size ===
		values.length
	);
}

/**
 * Check the original persisted identity, not just the decoded storage key.
 * Replacement chains may contain earlier safe names after an explicit rename.
 */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: persisted state is an external boundary and must be checked before effects. */
export function safeAlchemyState(value: unknown, expected: string): boolean {
	try {
		const seen = new Set<object>();
		let current: unknown = value;
		for (let depth = 0; depth < 64; depth++) {
			if (
				typeof current !== "object" ||
				current === null ||
				Array.isArray(current) ||
				seen.has(current)
			)
				return false;
			seen.add(current);
			const properties = Object.getOwnPropertyDescriptors(current);
			const fqn = properties.fqn;
			if (
				fqn === undefined ||
				!("value" in fqn) ||
				typeof fqn.value !== "string" ||
				!safeAlchemyFqn(fqn.value) ||
				(depth === 0 && fqn.value !== expected)
			)
				return false;
			const downstream = properties.downstream;
			if (
				downstream === undefined ||
				!("value" in downstream) ||
				!Array.isArray(downstream.value) ||
				downstream.value.length > 1024 ||
				downstream.value.some(
					(name: unknown) => typeof name !== "string" || !safeAlchemyFqn(name),
				)
			)
				return false;
			const old = properties.old;
			if (old === undefined) return true;
			if (!("value" in old)) return false;
			current = old.value;
		}
		return false;
	} catch {
		return false;
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** Read every live row while the plan still owns its state-store scope. */
export function verifyAlchemyStateIdentities(
	plan: StackPlan,
): Effect.Effect<boolean> {
	return Effect.gen(function* () {
		const state = yield* Context.get(plan.context, State);
		const scope = { stack: plan.stack.name, stage: plan.stack.stage };
		// The file and bucket stores omit their stack-output bookkeeping key
		// from list(). A legacy resource stored under that same key must not
		// disappear from the scan and be mistaken for an empty history.
		const output = yield* state.getOutput(scope);
		if (
			/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: stack output is external persisted data. */
			typeof output === "object" &&
			output !== null &&
			Object.getOwnPropertyDescriptor(output, "fqn")?.value ===
				"__stack_output__"
		)
			return false;
		const keys = yield* state.list(scope);
		if (
			keys.length > 1024 ||
			keys.some((key) => !safeAlchemyFqn(key)) ||
			!uniqueAlchemyFqns(keys)
		)
			return false;
		for (const fqn of keys) {
			const row = yield* state.get({ ...scope, fqn });
			if (row === undefined || !safeAlchemyState(row, fqn)) return false;
		}
		return true;
	}).pipe(
		Effect.exit,
		Effect.map((result) => Exit.isSuccess(result) && result.value),
	);
}

function scopeIsSafe(request: { stack: string; stage: string }): boolean {
	return (
		safeAlchemyStateSegment(request.stack) &&
		safeAlchemyStateSegment(request.stage)
	);
}

/** Fence every state read and write used by plan, apply, destroy and drift. */
function guardAlchemyState(state: StateService): StateService {
	const failure = () =>
		new StateStoreError({
			message:
				"STATE_IDENTITY_UNVERIFIED: unsafe or inconsistent Alchemy state identity",
		});
	const guarded: StateService = Object.assign(Object.create(state), {
		list: (request: Parameters<StateService["list"]>[0]) =>
			!scopeIsSafe(request)
				? Effect.fail(failure())
				: state
						.list(request)
						.pipe(
							Effect.flatMap((keys) =>
								keys.length > 1024 ||
								keys.some((key) => !safeAlchemyFqn(key)) ||
								!uniqueAlchemyFqns(keys)
									? Effect.fail(failure())
									: Effect.succeed(keys),
							),
						),
		get: (request: Parameters<StateService["get"]>[0]) =>
			!scopeIsSafe(request) || !safeAlchemyFqn(request.fqn)
				? Effect.fail(failure())
				: state
						.get(request)
						.pipe(
							Effect.flatMap((row) =>
								row !== undefined && !safeAlchemyState(row, request.fqn)
									? Effect.fail(failure())
									: Effect.succeed(row),
							),
						),
		set: <V extends Parameters<StateService["set"]>[0]["value"]>(request: {
			stack: string;
			stage: string;
			fqn: string;
			value: V;
		}) =>
			!scopeIsSafe(request) ||
			!safeAlchemyFqn(request.fqn) ||
			!safeAlchemyState(request.value, request.fqn)
				? Effect.fail(failure())
				: state.set(request),
		delete: (request: Parameters<StateService["delete"]>[0]) =>
			!scopeIsSafe(request) || !safeAlchemyFqn(request.fqn)
				? Effect.fail(failure())
				: state.delete(request),
		getReplacedResources: (
			request: Parameters<StateService["getReplacedResources"]>[0],
		) =>
			!scopeIsSafe(request)
				? Effect.fail(failure())
				: state
						.getReplacedResources(request)
						.pipe(
							Effect.flatMap((rows) =>
								rows.length > 1024 ||
								rows.some((row) => !safeAlchemyState(row, row.fqn))
									? Effect.fail(failure())
									: Effect.succeed(rows),
							),
						),
	});
	return guarded;
}

/** Preserve the store's own lifetime/lease while adding a guard in each stack build. */
export function guardAlchemyStack<Output, Requirements>(
	stack: Stack.ConfiguredStack<Output, Requirements>,
): Stack.ConfiguredStack<Output, Requirements> {
	const originalState = stack.state;
	const state = Layer.effect(
		State,
		Effect.map(State, (service) => Effect.map(service, guardAlchemyState)),
	).pipe(Layer.provide(originalState));
	const wrapped = Effect.map(stack, (compiled) => ({
		...compiled,
		services: Context.add(
			compiled.services,
			State,
			Effect.map(Context.get(compiled.services, State), guardAlchemyState),
		),
	}));
	return Object.assign(
		wrapped,
		{ stackName: stack.stackName, state, providers: stack.providers },
		stack.secrets === undefined ? {} : { secrets: stack.secrets },
	);
}
