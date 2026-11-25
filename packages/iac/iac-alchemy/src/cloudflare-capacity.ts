/* oxlint-disable anti-slop/no-unknown-returns -- SAFETY: native cancellation results are validated by the observer. */
import { observeCloudflareNativePromise } from "./cloudflare-native-promise.js";

export const CLOUDFLARE_NATIVE_MAX_OUTSTANDING = 128;
let outstanding = 0;
const apply = Reflect.apply;
const create = Object.create;
const freeze = Object.freeze;
const get = WeakMap.prototype.get;
const set = WeakMap.prototype.set;
const leases = new WeakMap<
	object,
	"active" | "cancellation" | "quarantined" | "released"
>();
declare const leaseBrand: unique symbol;
export interface CloudflareNativeLease {
	readonly [leaseBrand]: true;
}

export function reserveCloudflareNative(): CloudflareNativeLease | undefined {
	if (outstanding >= CLOUDFLARE_NATIVE_MAX_OUTSTANDING) return undefined;
	const lease = freeze(create(null)) as CloudflareNativeLease;
	apply(set, leases, [lease, "active"]);
	outstanding++;
	return lease;
}

export function releaseCloudflareNative(lease: CloudflareNativeLease): void {
	if (apply(get, leases, [lease]) !== "active") return;
	apply(set, leases, [lease, "released"]);
	outstanding--;
}

export function quarantineCloudflareNative(lease: CloudflareNativeLease): void {
	const state = apply(get, leases, [lease]);
	if (state === "active" || state === "cancellation")
		apply(set, leases, [lease, "quarantined"]);
}

export function cloudflareNativeTransferred(
	lease: CloudflareNativeLease,
): boolean {
	return apply(get, leases, [lease]) === "cancellation";
}

export function cloudflareNativeActive(lease: CloudflareNativeLease): boolean {
	return apply(get, leases, [lease]) === "active";
}

export type CloudflareRetirement = "none" | "pending" | "unavailable";

export function cancelCloudflareNative(
	start: () => unknown,
	transferred?: CloudflareNativeLease,
	canRelease?: () => boolean,
): CloudflareRetirement {
	const lease = transferred ?? reserveCloudflareNative();
	if (lease === undefined || apply(get, leases, [lease]) !== "active")
		return "unavailable";
	apply(set, leases, [lease, "cancellation"]);
	try {
		const result = start();
		if (
			!observeCloudflareNativePromise(
				result,
				() => {
					try {
						if (canRelease !== undefined && !canRelease()) {
							quarantineCloudflareNative(lease);
							return;
						}
						if (apply(get, leases, [lease]) !== "cancellation") return;
						apply(set, leases, [lease, "released"]);
						outstanding--;
					} catch {
						quarantineCloudflareNative(lease);
					}
				},
				() => quarantineCloudflareNative(lease),
			)
		) {
			quarantineCloudflareNative(lease);
			return "unavailable";
		}
		return "pending";
	} catch {
		quarantineCloudflareNative(lease);
		return "unavailable";
	}
}
