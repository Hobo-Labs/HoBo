/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: host authorization results must be classified without invoking untrusted objects. */
import { performance } from "node:perf_hooks";
import {
	type BoundaryPending,
	createBoundaryDeferred,
	observeBoundary,
	raceBoundary,
} from "./async-boundary.js";
import { observeOrdinaryPromise } from "./node-promise-boundary.js";

const applyCaptured = Reflect.apply;
const monotonicCaptured = performance.now;
const freezeCaptured = Object.freeze;
const createCaptured = Object.create;
const isFiniteCaptured = Number.isFinite;
const isSafeIntegerCaptured = Number.isSafeInteger;
const now = () => applyCaptured(monotonicCaptured, performance, []);

export const RIVET_HTTP_AUTHORIZATION_TIMEOUT_MS = 10_000;
export const RIVET_HTTP_AUTHORIZATION_CAPACITY = 128;
export interface RivetHttpAuthorizationDecision {
	readonly status: "allow" | "deny" | "unavailable";
	readonly expiresAt: number;
}

function outcome(
	status: RivetHttpAuthorizationDecision["status"],
	expiresAt: number,
): RivetHttpAuthorizationDecision {
	const result: {
		status: RivetHttpAuthorizationDecision["status"];
		expiresAt: number;
	} = createCaptured(null);
	result.status = status;
	result.expiresAt = expiresAt;
	return freezeCaptured(result);
}

export function rivetHttpAuthorizationCurrent(
	decision: RivetHttpAuthorizationDecision,
): boolean {
	return decision.status !== "unavailable" && now() < decision.expiresAt;
}

export function createRivetHttpAuthorizationGate(timeoutMs: number) {
	if (!isSafeIntegerCaptured(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
		throw new TypeError(
			"Rivet HTTP authorization timeout must be 1 to 60000 ms",
		);

	const scheduleTimer = setTimeout;
	const cancelTimer = clearTimeout;
	let pending = 0;
	return (
		decide: (current: () => boolean) => boolean | Promise<boolean>,
	): BoundaryPending<RivetHttpAuthorizationDecision> => {
		const output = createBoundaryDeferred<RivetHttpAuthorizationDecision>();
		let startedAt: number;
		try {
			startedAt = now();
		} catch {
			output.resolve(outcome("unavailable", 0));
			return output.promise;
		}
		const expiresAt = startedAt + timeoutMs;
		if (
			!isFiniteCaptured(startedAt) ||
			!isFiniteCaptured(expiresAt) ||
			pending >= RIVET_HTTP_AUTHORIZATION_CAPACITY
		) {
			output.resolve(outcome("unavailable", 0));
			return output.promise;
		}
		pending++;
		let expired = false;
		let completed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const work =
			createBoundaryDeferred<RivetHttpAuthorizationDecision["status"]>();
		const deadline =
			createBoundaryDeferred<RivetHttpAuthorizationDecision["status"]>();
		const current = () => {
			try {
				return !expired && now() < expiresAt;
			} catch {
				return false;
			}
		};
		observeBoundary(
			work.promise,
			() => {
				pending--;
			},
			() => {
				pending--;
			},
		);
		const publish = (status: RivetHttpAuthorizationDecision["status"]) => {
			if (completed) return;
			completed = true;
			if (timer !== undefined) {
				try {
					applyCaptured(cancelTimer, undefined, [timer]);
				} catch {
					timer = undefined;
				}
			}
			output.resolve(
				outcome(
					status !== "unavailable" && current() ? status : "unavailable",
					expiresAt,
				),
			);
		};
		observeBoundary(raceBoundary(work.promise, deadline.promise), publish, () =>
			publish("unavailable"),
		);
		try {
			timer = applyCaptured(scheduleTimer, undefined, [
				() => {
					expired = true;
					deadline.resolve("unavailable");
				},
				timeoutMs,
			]);
		} catch {
			expired = true;
			work.resolve("unavailable");
			deadline.resolve("unavailable");
			return output.promise;
		}
		if (!current()) {
			work.resolve("unavailable");
			deadline.resolve("unavailable");
			return output.promise;
		}
		const start = createBoundaryDeferred<void>();
		observeBoundary(
			start.promise,
			() => {
				if (!current()) {
					work.resolve("unavailable");
					return;
				}
				let result: unknown;
				try {
					result = decide(current);
				} catch {
					work.resolve("unavailable");
					return;
				}
				const accept = (value: unknown) => {
					work.resolve(
						current() && value === true
							? "allow"
							: current() && value === false
								? "deny"
								: "unavailable",
					);
				};
				if (
					typeof result === "boolean" ||
					result === null ||
					(typeof result !== "object" && typeof result !== "function")
				)
					accept(result);
				else if (
					!observeOrdinaryPromise(result, accept, () =>
						work.resolve("unavailable"),
					)
				) {
					deadline.resolve("unavailable");
				}
			},
			() => work.resolve("unavailable"),
		);
		start.resolve(undefined);
		return output.promise;
	};
}
