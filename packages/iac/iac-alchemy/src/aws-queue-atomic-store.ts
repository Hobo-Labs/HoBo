import { types } from "node:util";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { createAwsRuntimeBoundary } from "./aws-runtime-boundary.js";
import {
	createAwsDynamoKvStore,
	inspectAwsDynamoKvStore,
	type AwsKvGrant,
} from "./aws-kv.js";
import { acceptSynchronousTrue } from "./synchronous-result.js";

const apply = Reflect.apply;
const includes = Array.prototype.includes;
const freeze = Object.freeze;
const setPrototype = Object.setPrototypeOf;
const isSafeInteger = Number.isSafeInteger;
const nativeNumber = Number;
const nativeString = String;
const regexExec = RegExp.prototype.exec;
const revisionPattern = /^[1-9][0-9]*$/u;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;
const byteBuffer = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"buffer",
)?.get;
const byteSet = Uint8Array.prototype.set;
const key = "queue-state";
const maxBytes = 256 * 1024;

export interface AwsQueueAtomicStore {
	load(): Promise<AwsQueueAtomicRead>;
	compareAndSwap(
		revision: number,
		bytes: Uint8Array,
	): Promise<AwsQueueAtomicWrite>;
}
const storeIdentities = new WeakMap<object, AwsKvGrant>();
const identityGet = WeakMap.prototype.get;
const identitySet = WeakMap.prototype.set;
const identityProxy = types.isProxy;
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: only the factory registers a validated grant. */
export function inspectAwsQueueAtomicStore(
	value: unknown,
): AwsKvGrant | undefined {
	if (typeof value !== "object" || value === null || identityProxy(value))
		return undefined;
	return apply(identityGet, storeIdentities, [value]);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */

function outcome<T extends object>(value: T): T {
	setPrototype(value, null);
	return freeze(value);
}

export type AwsQueueAtomicRead =
	| { readonly status: "missing" }
	| {
			readonly status: "available";
			readonly revision: number;
			readonly bytes: Uint8Array;
	  }
	| { readonly status: "unavailable" };
export type AwsQueueAtomicWrite =
	| { readonly status: "committed" }
	| { readonly status: "unknown" };

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: a scoped host grant and bounded queue state cross the AWS boundary. */
export function createAwsQueueAtomicStore(
	options: Parameters<typeof createAwsDynamoKvStore>[0],
): AwsQueueAtomicStore {
	const validated = createAwsDynamoKvStore(options);
	const grant = inspectAwsDynamoKvStore(validated);
	if (grant === undefined) throw new TypeError("aws_queue.invalid_grant");
	const verify = options.verify;
	const layer = options.layer;
	const tableArn = `arn:${grant.partition}:dynamodb:${grant.region}:${grant.accountId}:table/${grant.tableName}`;
	const authorize = (operation: "get" | "set", requestedKey: string) => {
		try {
			return (
				requestedKey === key &&
				apply(includes, grant.allow, [operation]) &&
				acceptSynchronousTrue(verify(grant, operation, key))
			);
		} catch {
			return false;
		}
	};
	const boundary = createAwsRuntimeBoundary<"get" | "set">({
		layer,
		authorize,
		denied: () => new Error("aws_queue.denied"),
		capacity: () => new Error("aws_queue.capacity"),
		unavailable: () => new Error("aws_queue.unavailable"),
	});
	const copy = (value: Uint8Array): Uint8Array => {
		if (
			types.isProxy(value) ||
			!types.isUint8Array(value) ||
			byteLength === undefined ||
			byteBuffer === undefined
		)
			throw new TypeError("aws_queue.invalid_bytes");
		const length: unknown = apply(byteLength, value, []);
		const buffer: unknown = apply(byteBuffer, value, []);
		if (
			typeof length !== "number" ||
			!isSafeInteger(length) ||
			length < 0 ||
			length > maxBytes ||
			types.isSharedArrayBuffer(buffer)
		)
			throw new TypeError("aws_queue.invalid_bytes");
		const result = new Uint8Array(length);
		apply(byteSet, result, [value]);
		return result;
	};
	const store: AwsQueueAtomicStore = freeze({
		async load(): Promise<AwsQueueAtomicRead> {
			try {
				const response = (
					await boundary.run(
						"get",
						key,
						DynamoDB.getItem({
							TableName: tableArn,
							region: grant.region,
							Key: { pk: { S: key } },
							ConsistentRead: true,
						}),
					)
				).value;
				if (response.Item === undefined) {
					boundary.beforeReturn("get", key);
					return outcome({ status: "missing" });
				}
				const item = response.Item;
				const revisionText = item.revision?.N;
				if (
					Object.keys(item).length !== 3 ||
					item.pk?.S !== key ||
					typeof revisionText !== "string" ||
					apply(regexExec, revisionPattern, [revisionText]) === null ||
					!isSafeInteger(nativeNumber(revisionText)) ||
					!(item.state?.B instanceof Uint8Array)
				)
					throw new Error("aws_queue.invalid_state");
				const bytes = copy(item.state.B);
				boundary.beforeReturn("get", key);
				return outcome({
					status: "available",
					revision: nativeNumber(revisionText),
					bytes,
				});
			} catch {
				return outcome({ status: "unavailable" });
			}
		},
		async compareAndSwap(
			revision: number,
			bytes: Uint8Array,
		): Promise<AwsQueueAtomicWrite> {
			if (
				!isSafeInteger(revision) ||
				revision < 0 ||
				revision >= Number.MAX_SAFE_INTEGER
			)
				throw new TypeError("aws_queue.invalid_revision");
			const state = copy(bytes);
			try {
				const condition =
					revision === 0
						? { ConditionExpression: "attribute_not_exists(pk)" }
						: {
								ConditionExpression: "#revision = :revision",
								ExpressionAttributeNames: { "#revision": "revision" },
								ExpressionAttributeValues: {
									":revision": { N: nativeString(revision) },
								},
							};
				await boundary.run(
					"set",
					key,
					DynamoDB.putItem({
						TableName: tableArn,
						region: grant.region,
						Item: {
							pk: { S: key },
							revision: { N: nativeString(revision + 1) },
							state: { B: state },
						},
						...condition,
					}),
				);
				boundary.beforeReturn("set", key);
				return outcome({ status: "committed" });
			} catch {
				return outcome({ status: "unknown" });
			}
		},
	});
	apply(identitySet, storeIdentities, [store, grant]);
	return store;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */
