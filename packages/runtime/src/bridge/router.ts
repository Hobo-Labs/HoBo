import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import {
	type BoundaryExample,
	BoundaryRoutingError,
	type BoundaryServed,
	type BoundaryStatus,
	type BridgeContract,
	BridgeContractError,
	type BridgeOptions,
	type FaultOptions,
	type RecordedBoundaryCall,
	type ShadowDiff,
} from "./types.js";

const MAX_RECORDED_CALLS = 1_000;

type Handler<I, O> = (input: I) => O | Promise<O>;

/** Canonical (key-sorted) JSON so structurally equal inputs match. */
function canonical<T>(value: T): string {
	return JSON.stringify(sortKeys(cloneAsJson(value)));
}

function sortKeys(value: JsonValue | undefined): JsonValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || !isJsonObject(value)) return value ?? null;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortKeys(value[key])]),
	);
}

/**
 * PACT-style subset match: every key the expectation declares must be
 * present and equal in the actual value (extra actual keys are fine).
 */
export function isSubsetMatch(
	expected: JsonValue | undefined,
	actual: JsonValue | undefined,
): boolean {
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			expected.length === actual.length &&
			expected.every((item, index) => isSubsetMatch(item, actual[index]))
		);
	}
	if (expected && isJsonObject(expected)) {
		if (!actual || !isJsonObject(actual) || Array.isArray(actual)) {
			return false;
		}
		// SAFETY: assertion to `expected as JsonObject` is required at this boundary.
		return Object.entries(expected as JsonObject).every(([key, value]) =>
			// SAFETY: assertion to `actual as JsonObject` is required at this boundary.
			isSubsetMatch(value, (actual as JsonObject)[key]),
		);
	}
	return Object.is(expected, actual);
}

interface BoundaryState {
	live?: Handler<JsonValue, JsonValue>;
	mock?: readonly BoundaryExample[];
	/** Bridged handlers by session tag; "" is the catch-all bridge. */
	bridges: Map<string, Handler<JsonValue, JsonValue>>;
	shadow?: Handler<JsonValue, JsonValue>;
	fault?: FaultOptions | undefined;
	replaying: boolean;
	calls: RecordedBoundaryCall[];
	shadowDiffs: ShadowDiff[];
	order: number;
}

export interface Boundary<I = JsonValue, O = JsonValue> {
	readonly name: string;
	/** The upstream (deployed/remote) implementation of this boundary. */
	live(handler: Handler<I, O>): Boundary<I, O>;
	/** PACT-derived canned responses — no hand-written mocks (ADR-0076). */
	mock(examples: readonly BoundaryExample<I, O>[]): Boundary<I, O>;
	/**
	 * Bridge the boundary to a local implementation. Contract-verified
	 * BEFORE activation; session-scoped unless no session is given.
	 */
	bridge(handler: Handler<I, O>, options?: BridgeOptions<I, O>): Promise<void>;
	/** Tear the bridge down (one session, or every bridge when omitted). */
	unbridge(session?: string): void;
	/** Duplicate served traffic to a candidate; its output is never returned. */
	shadow(candidate: Handler<I, O>): Boundary<I, O>;
	/** Chaos at the boundary — optionally scoped to one dev session. */
	fault(options: FaultOptions): Boundary<I, O>;
	clearFault(): void;
	/** Serve recorded outputs instead of calling anything. */
	replay(enabled?: boolean): Boundary<I, O>;
	call(input: I, context?: { session?: string }): Promise<O>;
	calls(): readonly RecordedBoundaryCall<I, O>[];
	shadowDiffs(): readonly ShadowDiff<I>[];
	status(): BoundaryStatus;
}

export interface BoundaryRouter {
	boundary<I = JsonValue, O = JsonValue>(name: string): Boundary<I, O>;
	status(): readonly BoundaryStatus[];
	reset(): void;
}

async function verifyContract<I, O>(
	boundary: string,
	handler: Handler<I, O>,
	contract: BridgeContract<I, O>,
): Promise<void> {
	const failures: string[] = [];
	for (const example of contract.examples) {
		try {
			const actual = await handler(example.input);
			if (!isSubsetMatch(cloneAsJson(example.output), cloneAsJson(actual))) {
				failures.push(
					`for input ${canonical(example.input)} expected ${canonical(
						example.output,
					)} ⊆ actual, got ${canonical(actual)}`,
				);
			}
		} catch (error) {
			failures.push(
				`input ${canonical(example.input)} threw: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	if (failures.length > 0) {
		throw new BridgeContractError(boundary, failures);
	}
}

/**
 * Create a boundary router — the in-process seam every service boundary
 * routes through. A Camp's host wires real transports behind it; tests and
 * `hobo dev` wire it directly. All ADR-0076 modes compose per boundary,
 * and bridged routing is per dev session, which is what turns "fork the
 * whole environment" into "fork exactly your requests".
 */
export function createBoundaryRouter(): BoundaryRouter {
	const boundaries = new Map<string, BoundaryState>();

	function stateFor(name: string): BoundaryState {
		let state = boundaries.get(name);
		if (!state) {
			state = {
				bridges: new Map(),
				replaying: false,
				calls: [],
				shadowDiffs: [],
				order: 0,
			};
			boundaries.set(name, state);
		}
		return state;
	}

	function record(
		state: BoundaryState,
		call: Omit<RecordedBoundaryCall, "order">,
	): void {
		if (state.calls.length >= MAX_RECORDED_CALLS) state.calls.shift();
		state.calls.push(Object.freeze({ ...call, order: state.order }));
		state.order += 1;
	}

	function statusOf(name: string, state: BoundaryState): BoundaryStatus {
		return {
			boundary: name,
			hasLive: state.live !== undefined,
			mockExamples: state.mock?.length ?? 0,
			bridgedSessions: [...state.bridges.keys()].map((key) =>
				key === "" ? "(all traffic)" : key,
			),
			replaying: state.replaying,
			shadowing: state.shadow !== undefined,
			...(state.fault ? { fault: state.fault.message } : undefined),
			calls: state.calls.length,
		};
	}

	function makeBoundary<I, O>(name: string): Boundary<I, O> {
		const state = stateFor(name);

		const runShadow = (input: I, served: JsonValue): void => {
			const candidate = state.shadow;
			if (!candidate) return;
			// Fire the candidate on the same input; its result is captured
			// for comparison and always discarded.
			void Promise.resolve()
				.then(() => {
					// SAFETY: erased shadow handler is invoked with the boundary input.
					return candidate(input as never);
				})
				.then((result) => {
					const diff = Object.freeze({
						input,
						served,
						candidate: result,
						matched: canonical(result) === canonical(served),
						order: state.shadowDiffs.length,
					});
					// SAFETY: shadow diffs are stored erased across boundary I/O types.
					state.shadowDiffs.push(diff as never);
				})
				.catch((error) => {
					const diff = Object.freeze({
						input,
						served,
						candidate: `threw: ${
							error instanceof Error ? error.message : String(error)
						}`,
						matched: false,
						order: state.shadowDiffs.length,
					});
					// SAFETY: shadow diffs are stored erased across boundary I/O types.
					state.shadowDiffs.push(diff as never);
				});
		};

		const serve = async (
			input: I,
			served: BoundaryServed,
			session: string | undefined,
			handler: () => Promise<O> | O,
		): Promise<O> => {
			try {
				const output = await handler();
				const recorded = {
					input,
					output,
					served,
					...(session !== undefined ? { session } : undefined),
				};
				// SAFETY: recorded calls are stored erased across boundary I/O types.
				record(state, recorded as never);
				if (served === "live" || served === "bridge") {
					runShadow(input, cloneAsJson(output));
				}
				return output;
			} catch (error) {
				const recorded = {
					input,
					error: error instanceof Error ? error.message : String(error),
					served,
					...(session !== undefined ? { session } : undefined),
				};
				// SAFETY: recorded calls are stored erased across boundary I/O types.
				record(state, recorded as never);
				throw error;
			}
		};

		const boundary: Boundary<I, O> = {
			name,
			live(handler) {
				// SAFETY: generic live handler is stored erased at the router boundary.
				state.live = handler as never;
				return boundary;
			},
			mock(examples) {
				// SAFETY: assertion to ` as readonly BoundaryExample[]; re` is required at this boundary.
				state.mock = examples as readonly BoundaryExample[];
				return boundary;
			},
			async bridge(handler, options = {}) {
				if (options.contract) {
					await verifyContract(name, handler, options.contract);
				}
				state.bridges.set(
					options.session ?? "",
					// SAFETY: generic bridge handler is stored erased at the router boundary.
					handler as never,
				);
			},
			unbridge(session) {
				if (session === undefined) state.bridges.clear();
				else state.bridges.delete(session);
			},
			shadow(candidate) {
				// SAFETY: generic shadow handler is stored erased at the router boundary.
				state.shadow = candidate as never;
				return boundary;
			},
			fault(options) {
				state.fault = options;
				return boundary;
			},
			clearFault() {
				state.fault = undefined;
			},
			replay(enabled = true) {
				state.replaying = enabled;
				return boundary;
			},
			async call(input, context = {}) {
				const session = context.session;
				const fault = state.fault;
				if (
					fault &&
					(fault.session === undefined || fault.session === session)
				) {
					return serve(input, "fault", session, () => {
						throw new BoundaryRoutingError(
							`fault injected at boundary "${name}": ${fault.message}`,
						);
					});
				}
				const bridged =
					(session !== undefined ? state.bridges.get(session) : undefined) ??
					state.bridges.get("");
				if (bridged) {
					// SAFETY: erased handler is invoked with the boundary's input type.
					return serve(
						input,
						"bridge",
						session,
						() => bridged(input as never) as O,
					);
				}
				if (state.replaying) {
					const key = canonical(input);
					const recorded = [...state.calls]
						.reverse()
						.find(
							(call) =>
								call.output !== undefined && canonical(call.input) === key,
						);
					if (!recorded) {
						throw new BoundaryRoutingError(
							`boundary "${name}" is replaying but has no recorded output for input ${key}`,
						);
					}
					// SAFETY: assertion to `.output as O); }` is required at this boundary.
					return serve(input, "replay", session, () => recorded.output as O);
				}
				if (state.live) {
					const live = state.live;
					// SAFETY: erased live handler is invoked with the boundary's input type.
					return serve(input, "live", session, () => live(input as never) as O);
				}
				if (state.mock) {
					const examples = state.mock;
					return serve(input, "mock", session, () => {
						const key = canonical(input);
						const matched = examples.find(
							(example) => canonical(example.input) === key,
						);
						const example = matched ?? examples[0];
						if (!example) {
							throw new BoundaryRoutingError(
								`boundary "${name}" has an empty mock — give it PACT examples`,
							);
						}
						// SAFETY: assertion to `tput as O; });` is required at this boundary.
						return example.output as O;
					});
				}
				throw new BoundaryRoutingError(
					`boundary "${name}" has no route: no live handler, no mock, no bridge`,
				);
			},
			calls() {
				// SAFETY: recorded calls are restored to the boundary's I/O types.
				return [...state.calls] as never;
			},
			shadowDiffs() {
				// SAFETY: shadow diffs are restored to the boundary's input type.
				return [...state.shadowDiffs] as never;
			},
			status() {
				return statusOf(name, state);
			},
		};
		return boundary;
	}

	return {
		boundary<I, O>(name: string): Boundary<I, O> {
			if (!isJsonString(name) || name.trim().length === 0) {
				throw new BoundaryRoutingError(
					"boundary names must be non-empty strings",
				);
			}
			return makeBoundary<I, O>(name);
		},
		status() {
			return [...boundaries.entries()].map(([name, state]) =>
				statusOf(name, state),
			);
		},
		reset() {
			boundaries.clear();
		},
	};
}
