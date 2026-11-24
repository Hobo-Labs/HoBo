/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: timeout identity is checked at the native-operation boundary. */
import {
	type BoundaryBox,
	createBoundaryDeferred,
	observeBoundary,
	raceBoundary,
} from "./async-boundary.js";
import {
	type CloudflareNativeLease,
	type CloudflareRetirement,
	cloudflareNativeActive,
	cloudflareNativeTransferred,
	quarantineCloudflareNative,
	releaseCloudflareNative,
	reserveCloudflareNative,
} from "./cloudflare-capacity.js";
import { observeCloudflareNativePromise } from "./cloudflare-native-promise.js";

const apply = Reflect.apply;
const clock = performance;
const now = performance.now;
const setTimer = setTimeout;
const clearTimer = clearTimeout;
const NativeError = Error;
const timeoutAdd = WeakSet.prototype.add;
const timeoutHas = WeakSet.prototype.has;
const timeouts = new WeakSet<object>();

class CloudflareNativeTimeout extends NativeError {
	constructor() {
		super("native operation timed out");
		apply(timeoutAdd, timeouts, [this]);
	}
}

export function isCloudflareNativeTimeout(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	return apply(timeoutHas, timeouts, [value]);
}

export function createCloudflareDeadline(onTimeout?: () => void) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let expired = false;
	const expiresAt = apply(now, clock, []) + 10_000;
	const deadline = createBoundaryDeferred<never>();

	observeBoundary(
		deadline.promise,
		() => {},
		() => {},
	);
	const expire = () => {
		if (expired) return;
		expired = true;
		try {
			if (onTimeout !== undefined) apply(onTimeout, undefined, []);
		} catch {
			expired = true;
		}
		deadline.reject(new CloudflareNativeTimeout());
	};
	const current = () => {
		if (expired) return false;
		if (apply(now, clock, []) < expiresAt) return true;
		expire();
		return false;
	};
	timer = setTimer(expire, 10_000);
	return {
		async run<T>(
			start: () => Promise<T>,
			onLate?: (value: T, lease: CloudflareNativeLease) => CloudflareRetirement,
		): Promise<BoundaryBox<T>> {
			const gate = createBoundaryDeferred<void>();
			gate.resolve(undefined);
			await gate.promise;
			let retired = false;
			let status: CloudflareRetirement = "unavailable";
			const retire = (
				value: T,
				lease: CloudflareNativeLease,
			): CloudflareRetirement => {
				if (retired) return status;
				retired = true;
				if (onLate === undefined) {
					status = "none";
					return status;
				}
				try {
					const result = apply(onLate, undefined, [value, lease]);
					if (result === "none" && cloudflareNativeActive(lease))
						status = result;
					else if (result === "pending" && cloudflareNativeTransferred(lease))
						status = result;
				} catch {}
				if (status === "unavailable") quarantineCloudflareNative(lease);
				return status;
			};
			if (!current()) throw new CloudflareNativeTimeout();
			const lease = reserveCloudflareNative();
			if (lease === undefined)
				throw new NativeError("native capacity unavailable");
			const settled = createBoundaryDeferred<boolean>();
			observeBoundary(
				settled.promise,
				(safe) => {
					if (safe) releaseCloudflareNative(lease);
				},
				() => {},
			);
			const work = createBoundaryDeferred<T>();
			const pending = raceBoundary(work.promise, deadline.promise);
			observeBoundary(
				pending,
				() => {},
				() => {},
			);
			let native: Promise<T>;
			try {
				native = start();
			} catch (error) {
				quarantineCloudflareNative(lease);
				if (!current()) throw new CloudflareNativeTimeout();
				throw error;
			}
			if (
				!observeCloudflareNativePromise<T>(
					native,
					(value) => {
						if (!current()) {
							settled.resolve(retire(value, lease) === "none");
							work.reject(new CloudflareNativeTimeout());
							return;
						}
						work.resolve(value);
					},
					() => {
						settled.resolve(true);
						work.reject(
							current()
								? new NativeError("native operation failed")
								: new CloudflareNativeTimeout(),
						);
					},
				)
			) {
				quarantineCloudflareNative(lease);
				if (!current()) throw new CloudflareNativeTimeout();
				throw new NativeError("native operation could not be observed");
			}
			let result: BoundaryBox<T>;
			try {
				result = await pending;
			} catch (error) {
				if (!current()) throw new CloudflareNativeTimeout();
				throw error;
			}
			if (!current()) {
				settled.resolve(retire(result.value, lease) === "none");
				throw new CloudflareNativeTimeout();
			}
			settled.resolve(true);
			return result;
		},
		close() {
			if (!expired) {
				expired = true;
				deadline.reject(new CloudflareNativeTimeout());
			}
			if (timer !== undefined) clearTimer(timer);
			timer = undefined;
		},
	};
}

export function awaitCloudflareNative<T>(
	start: () => Promise<T>,
	onTimeout?: () => void,
	onLate?: (value: T, lease: CloudflareNativeLease) => CloudflareRetirement,
): Promise<BoundaryBox<T>> {
	const deadline = createCloudflareDeadline(onTimeout);
	const pending = deadline.run(start, onLate);
	if (
		!observeCloudflareNativePromise(
			pending,
			() => deadline.close(),
			() => deadline.close(),
		)
	) {
		deadline.close();
		throw new NativeError("deadline result could not be observed");
	}
	return pending;
}
