import { types } from "node:util";
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

/** Snapshot a bounded dense array without invoking accessor-backed elements. */
/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: state-store data crosses an external boundary. */
function stateArray(value: unknown): unknown[] | undefined {
	try {
		if (types.isProxy(value) || !Array.isArray(value)) return undefined;
		const declaredLength = Object.getOwnPropertyDescriptor(value, "length");
		if (
			declaredLength === undefined ||
			!("value" in declaredLength) ||
			!Number.isSafeInteger(declaredLength.value) ||
			declaredLength.value < 0 ||
			declaredLength.value > 1024
		)
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(value);
		const lengthDescriptor: PropertyDescriptor | undefined =
			Object.getOwnPropertyDescriptor(properties, "length")?.value;
		const length = lengthDescriptor?.value;
		if (
			length !== declaredLength.value ||
			Reflect.ownKeys(properties).length !== length + 1
		)
			return undefined;
		const snapshot: unknown[] = [];
		for (let index = 0; index < length; index++) {
			const element = properties[String(index)];
			if (element === undefined || !("value" in element)) return undefined;
			snapshot.push(element.value);
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: state-store data crosses an external boundary. */
function stateFqns(value: unknown): string[] | undefined {
	const snapshot = stateArray(value);
	if (
		snapshot === undefined ||
		snapshot.some(
			/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: state-store entries are untrusted. */
			(item) => typeof item !== "string" || !safeAlchemyFqn(item),
		)
	)
		return undefined;
	// SAFETY: the predicate above establishes that every element is a bounded FQN.
	return snapshot as string[];
}

/** Guard case-insensitive stores as well as Alchemy's FQN encoding. */
export function uniqueAlchemyFqns(values: readonly string[]): boolean {
	const snapshot = stateFqns(values);
	return (
		snapshot !== undefined &&
		new Set(snapshot.map((value) => encodeFqn(value).toLowerCase())).size ===
			snapshot.length
	);
}

/**
 * Capture every identity-bearing row and downstream list. Other fields retain
 * their provider values; the host fences their mutation during execution.
 */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns -- SAFETY: persisted state is an external boundary; bounded data descriptors are inspected before copying. */
function snapshotStateIdentity(
	value: unknown,
	expected: string,
): object | undefined {
	const seen = new Set<object>();
	const snapshot = (current: unknown, depth: number): object | undefined => {
		if (
			depth >= 64 ||
			typeof current !== "object" ||
			current === null ||
			types.isProxy(current) ||
			Array.isArray(current) ||
			seen.has(current)
		)
			return undefined;
		const prototype = Object.getPrototypeOf(current);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		seen.add(current);
		const keys = Reflect.ownKeys(current);
		if (keys.length > 256 || keys.some((key) => typeof key !== "string"))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(current);
		const fqn = properties.fqn;
		if (
			fqn === undefined ||
			!("value" in fqn) ||
			typeof fqn.value !== "string" ||
			!safeAlchemyFqn(fqn.value) ||
			(depth === 0 && fqn.value !== expected)
		)
			return undefined;
		const downstreamProperty = properties.downstream;
		if (downstreamProperty === undefined || !("value" in downstreamProperty))
			return undefined;
		const downstream = stateFqns(downstreamProperty.value);
		if (downstream === undefined) return undefined;
		const status = properties.status;
		if (status !== undefined && !("value" in status)) return undefined;
		const old = properties.old;
		let oldSnapshot: object | undefined;
		if (old !== undefined) {
			if (!("value" in old)) return undefined;
			// Alchemy's updating checkpoint permits an old values-only snapshot.
			const oldValue = old.value;
			if (
				status?.value === "updating" &&
				typeof oldValue === "object" &&
				oldValue !== null &&
				!types.isProxy(oldValue) &&
				!Array.isArray(oldValue) &&
				Object.getOwnPropertyDescriptor(oldValue, "fqn") === undefined
			) {
				const oldPrototype = Object.getPrototypeOf(oldValue);
				if (oldPrototype !== Object.prototype && oldPrototype !== null)
					return undefined;
				const names = Reflect.ownKeys(oldValue);
				if (
					names.length !== 3 ||
					!["props", "bindings", "attr"].every((key) => names.includes(key))
				)
					return undefined;
				const descriptors = Object.getOwnPropertyDescriptors(oldValue);
				if (
					Object.values(descriptors).some(
						(descriptor) => !("value" in descriptor),
					)
				)
					return undefined;
				oldSnapshot = Object.freeze(
					Object.defineProperties(Object.create(oldPrototype), descriptors),
				);
			} else {
				oldSnapshot = snapshot(oldValue, depth + 1);
			}
			if (oldSnapshot === undefined) return undefined;
		}
		const copied: PropertyDescriptorMap = Object.create(null);
		for (const key of keys) {
			if (typeof key !== "string") return undefined;
			const property = properties[key];
			if (property === undefined || !("value" in property)) return undefined;
			copied[key] = {
				...property,
				value:
					key === "downstream"
						? Object.freeze(downstream)
						: key === "old"
							? oldSnapshot
							: property.value,
			};
		}
		return Object.freeze(
			Object.defineProperties(Object.create(prototype), copied),
		);
	};
	try {
		return snapshot(value, 0);
	} catch {
		return undefined;
	}
}

/** Check persisted identity, including bounded replacement and update history. */
export function safeAlchemyState(value: unknown, expected: string): boolean {
	return snapshotStateIdentity(value, expected) !== undefined;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns */

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: stack output is external persisted data. */
function isLegacyOutputState(output: unknown): boolean {
	return (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: stack output is external persisted data. */
		typeof output === "object" &&
		output !== null &&
		(types.isProxy(output) ||
			Object.getOwnPropertyDescriptor(output, "fqn")?.value ===
				"__stack_output__")
	);
}

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
		if (isLegacyOutputState(output)) return false;
		const keys = stateFqns(yield* state.list(scope));
		if (keys === undefined || !uniqueAlchemyFqns(keys)) return false;
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

type StateScope = Readonly<{ stack: string; stage: string }>;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: state requests may originate in provider code; inspect data properties without invoking accessors or proxies. */
function stateProperty(
	input: unknown,
	name: string,
): PropertyDescriptor | undefined {
	try {
		if (typeof input !== "object" || input === null || types.isProxy(input))
			return undefined;
		const property = Object.getOwnPropertyDescriptor(input, name);
		return property !== undefined && "value" in property ? property : undefined;
	} catch {
		return undefined;
	}
}

function scopedRequest(input: unknown, scope: StateScope): boolean {
	return (
		stateProperty(input, "stack")?.value === scope.stack &&
		stateProperty(input, "stage")?.value === scope.stage
	);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** Guard the compiled engine's state service; stack evaluation requires a host sandbox. */
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: provider requests cross the state boundary and FQNs must be checked before use. */
export function guardAlchemyState(
	state: StateService,
	requestedScope: StateScope,
): StateService {
	const scope = Object.freeze({
		stack: requestedScope.stack,
		stage: requestedScope.stage,
	});
	if (
		!safeAlchemyStateSegment(scope.stack) ||
		!safeAlchemyStateSegment(scope.stage)
	)
		throw new Error("STATE_IDENTITY_INVALID: invalid state scope");
	const failure = () =>
		new StateStoreError({
			message:
				"STATE_IDENTITY_UNVERIFIED: unsafe or inconsistent Alchemy state identity",
		});
	const guarded: StateService = {
		id: state.id,
		getVersion: () => state.getVersion(),
		// Account-wide discovery and migration are outside an authorized stage.
		listStacks: () => Effect.fail(failure()),
		listStages: () => Effect.fail(failure()),
		list: (request: Parameters<StateService["list"]>[0]) =>
			!scopedRequest(request, scope)
				? Effect.fail(failure())
				: state.getOutput(scope).pipe(
						Effect.flatMap((output) =>
							isLegacyOutputState(output)
								? Effect.fail(failure())
								: state.list(scope),
						),
						Effect.flatMap((rawKeys) => {
							const keys = stateFqns(rawKeys);
							return keys === undefined || !uniqueAlchemyFqns(keys)
								? Effect.fail(failure())
								: Effect.succeed(keys);
						}),
					),
		get: (request: Parameters<StateService["get"]>[0]) => {
			const fqn = stateProperty(request, "fqn")?.value;
			if (
				!scopedRequest(request, scope) ||
				typeof fqn !== "string" ||
				!safeAlchemyFqn(fqn)
			)
				return Effect.fail(failure());
			return state.get({ ...scope, fqn }).pipe(
				Effect.flatMap((row) => {
					if (row === undefined) return Effect.succeed(undefined);
					const captured = snapshotStateIdentity(row, fqn);
					if (captured === undefined) return Effect.fail(failure());
					// SAFETY: the snapshot preserves the stored typed row's data fields and copies its identity.
					return Effect.succeed(captured as typeof row);
				}),
			);
		},
		set: <V extends Parameters<StateService["set"]>[0]["value"]>(request: {
			stack: string;
			stage: string;
			fqn: string;
			value: V;
		}) => {
			const fqn = stateProperty(request, "fqn")?.value;
			const value = stateProperty(request, "value");
			if (
				!scopedRequest(request, scope) ||
				typeof fqn !== "string" ||
				!safeAlchemyFqn(fqn) ||
				value === undefined
			)
				return Effect.fail(failure());
			const captured = snapshotStateIdentity(value.value, fqn);
			if (captured === undefined) return Effect.fail(failure());
			// SAFETY: the snapshot preserves the original typed row's own data fields and copies every verified identity field.
			return state.set({ ...scope, fqn, value: captured as V });
		},
		delete: (request: Parameters<StateService["delete"]>[0]) => {
			const fqn = stateProperty(request, "fqn")?.value;
			return !scopedRequest(request, scope) ||
				typeof fqn !== "string" ||
				!safeAlchemyFqn(fqn)
				? Effect.fail(failure())
				: state.delete({ ...scope, fqn });
		},
		getReplacedResources: (
			request: Parameters<StateService["getReplacedResources"]>[0],
		) =>
			!scopedRequest(request, scope)
				? Effect.fail(failure())
				: state.getReplacedResources(scope).pipe(
						Effect.flatMap((rows) => {
							const snapshot = stateArray(rows);
							if (snapshot === undefined) return Effect.fail(failure());
							const capturedRows: Array<(typeof rows)[number]> = [];
							/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these rows cross the state-store boundary and are inspected before use. */
							for (const row of snapshot) {
								const fqn = stateProperty(row, "fqn");
								if (fqn === undefined || typeof fqn.value !== "string")
									return Effect.fail(failure());
								const captured = snapshotStateIdentity(row, fqn.value);
								if (captured === undefined) return Effect.fail(failure());
								// SAFETY: the snapshot preserves the backend's typed replacement row's fields and verified identity.
								capturedRows.push(captured as (typeof rows)[number]);
							}
							/* oxlint-enable anti-slop/no-runtime-typeof */
							return Effect.succeed(capturedRows);
						}),
					),
		deleteStack: (request) =>
			scopedRequest(request, scope)
				? state.deleteStack(scope)
				: Effect.fail(failure()),
		getOutput: (request) =>
			scopedRequest(request, scope)
				? state
						.getOutput(scope)
						.pipe(
							Effect.flatMap((output) =>
								isLegacyOutputState(output)
									? Effect.fail(failure())
									: Effect.succeed(output),
							),
						)
				: Effect.fail(failure()),
		setOutput: (request) => {
			const value = stateProperty(request, "value");
			return !scopedRequest(request, scope) || value === undefined
				? Effect.fail(failure())
				: state.setOutput({ ...scope, value: value.value });
		},
		migrate: () => Effect.fail(failure()),
	};
	return Object.freeze(guarded);
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** Preserve the store's own lifetime/lease while adding a guard in each stack build. */
export function guardAlchemyStack<Output, Requirements>(
	stack: Stack.ConfiguredStack<Output, Requirements>,
	scope: StateScope,
): Stack.ConfiguredStack<Output, Requirements> {
	const originalState = stack.state;
	const state = Layer.effect(
		State,
		Effect.map(State, (service) =>
			Effect.map(service, (value) => guardAlchemyState(value, scope)),
		),
	).pipe(Layer.provide(originalState));
	const wrapped = Effect.map(stack, (compiled) => ({
		...compiled,
		services: Context.add(
			compiled.services,
			State,
			Effect.map(Context.get(compiled.services, State), (value) =>
				guardAlchemyState(value, scope),
			),
		),
	}));
	return Object.assign(
		wrapped,
		{ stackName: stack.stackName, state, providers: stack.providers },
		stack.secrets === undefined ? {} : { secrets: stack.secrets },
	);
}
