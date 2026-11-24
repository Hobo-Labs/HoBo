/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: stream ownership crosses the host boundary. */
import { types } from "node:util";
import { observeOrdinaryPromise } from "./node-promise-boundary.js";

const apply = Reflect.apply;
const isProxy = types.isProxy;
const descriptor = Object.getOwnPropertyDescriptor;
const requestBody = descriptor(Request.prototype, "body")?.get;
const responseBody = descriptor(Response.prototype, "body")?.get;
const cancelStream = ReadableStream.prototype.cancel;
const NativeSet = Set;
const setHas = NativeSet.prototype.has;
const setAdd = NativeSet.prototype.add;

const MAX_HTTP_RETIREMENTS = 128;

export interface RivetHttpRetirement {
	request(request: Request): void;
	response(response: Response): void;

	transferResponse(response: Response, delivered: Response): void;

	quarantine(): void;

	onRelease(cleanup: () => void): void;

	retainSignal(): void;
	finish(): void;
}

export function createRivetHttpRetirementGate(): () =>
	| RivetHttpRetirement
	| undefined {
	let held = 0;
	return () => {
		if (held >= MAX_HTTP_RETIREMENTS) return undefined;
		held++;
		let pending = 0;
		let closed = false;
		let uncertain = false;
		let released = false;
		let cleanup: (() => void) | undefined;
		const bodies = new NativeSet<object>();
		const release = () => {
			if (closed && pending === 0 && !uncertain && !released) {
				try {
					cleanup?.();
				} catch {
					uncertain = true;
					return;
				}
				released = true;
				held--;
			}
		};
		const retire = (owner: Request | Response, getter: typeof requestBody) => {
			try {
				if (isProxy(owner) || getter === undefined) {
					uncertain = true;
					return;
				}
				const body: unknown = apply(getter, owner, []);
				if (body === null) return;
				if (typeof body !== "object" || body === null || isProxy(body)) {
					uncertain = true;
					return;
				}
				if (apply(setHas, bodies, [body])) return;
				apply(setAdd, bodies, [body]);
				pending++;
				try {
					const cancellation: unknown = apply(cancelStream, body, []);
					if (
						!observeOrdinaryPromise(
							cancellation,
							() => {
								pending--;
								release();
							},
							() => {
								pending--;
								uncertain = true;
								release();
							},
						)
					) {
						pending--;
						uncertain = true;
					}
				} catch {
					pending--;
					uncertain = true;
				}
			} catch {
				uncertain = true;
			}
		};
		return {
			request: (request) => retire(request, requestBody),
			response: (response) => retire(response, responseBody),
			transferResponse: (response, delivered) => {
				try {
					if (
						isProxy(response) ||
						isProxy(delivered) ||
						responseBody === undefined
					) {
						uncertain = true;
						return;
					}
					const original: unknown = apply(responseBody, response, []);
					const retained: unknown = apply(responseBody, delivered, []);
					if (isProxy(original) || isProxy(retained)) {
						uncertain = true;
						return;
					}
					if (original !== null && original !== retained) uncertain = true;
				} catch {
					uncertain = true;
				}
			},
			quarantine: () => {
				uncertain = true;
			},
			onRelease: (callback) => {
				cleanup = callback;
			},
			retainSignal: () => {
				cleanup = undefined;
			},
			finish: () => {
				closed = true;
				release();
			},
		};
	};
}
