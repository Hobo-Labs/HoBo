/**
 * Operation metering for the Blob binding.
 *
 * `meterVercelBlobSdk` wraps the SDK and counts what is actually sent, by
 * billable class: every `get` is a simple operation, every `put` and `list`
 * an advanced one (a refused conditional upload included), every `del` a
 * free delete. That is the figure `test/blob-cost.test.ts` checks against
 * `VERCEL_BLOB_EPHEMERAL_COST`. Only method names and counts reach the meter;
 * pathnames, bodies and ETags never do.
 */
import type { VercelBlobOperationCounts } from "./cost.js";
import type { VercelBlobSdk, VercelBlobSdkMethodName } from "./sdk.js";

// domain-view: number-valued view of the generated VercelBlobUsage (whose int64 fields are bigint on the wire).
export type VercelBlobUsageSnapshot = VercelBlobOperationCounts & {
	readonly callsByMethod: Readonly<Record<VercelBlobSdkMethodName, number>>;
};

export type MeteredVercelBlobSdk = VercelBlobSdk & {
	usage(): VercelBlobUsageSnapshot;
	reset(): void;
};

export function meterVercelBlobSdk(
	inner: VercelBlobSdk,
	options: { readonly onCall?: (method: VercelBlobSdkMethodName) => void } = {},
): MeteredVercelBlobSdk {
	let calls = { put: 0, get: 0, del: 0, list: 0 };
	const count = (method: VercelBlobSdkMethodName) => {
		calls[method] += 1;
		options.onCall?.(method);
	};
	return {
		put(pathname, body, putOptions) {
			count("put");
			return inner.put(pathname, body, putOptions);
		},
		get(pathname, getOptions) {
			count("get");
			return inner.get(pathname, getOptions);
		},
		del(pathname, delOptions) {
			count("del");
			return inner.del(pathname, delOptions);
		},
		list(listOptions) {
			count("list");
			return inner.list(listOptions);
		},
		usage() {
			return {
				simple: calls.get,
				advanced: calls.put + calls.list,
				deletes: calls.del,
				callsByMethod: { ...calls },
			};
		},
		reset() {
			calls = { put: 0, get: 0, del: 0, list: 0 };
		},
	};
}
