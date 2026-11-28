/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: the source joins host-supplied authorities to bounded application data. */
import { types } from "node:util";
import type { CryptographyPort } from "@hobo/core/cryptography";
import type { NotificationPort } from "@hobo/core/notification";
import {
	type DurableQueue,
	inspectAtomicDurableQueue,
} from "@hobo/runtime/atomic-durable-queue";
import { inspectAwsKmsCryptography } from "./aws-cryptography.js";
import { type AwsHttpGraph, captureAwsHttpGraph } from "./aws-http-graph.js";
import {
	type AwsBindleApplication,
	type AwsHttpBindingClaim,
	type AwsHttpEntrypoint,
	createAwsBindleApplication,
} from "./aws-http-runtime.js";
import { type AwsKvStore, inspectAwsDynamoKvStore } from "./aws-kv.js";
import { inspectAwsNotificationPublisher } from "./aws-notification.js";
import { inspectAwsQueueAtomicStore } from "./aws-queue-atomic-store.js";
import { type AwsS3Store, inspectAwsS3Store } from "./aws-s3.js";
import { type AwsSecretStore, inspectAwsSecretStore } from "./aws-secret.js";
import type { BindleForAlchemy } from "./bindle.js";
import {
	acceptSynchronousTrue,
	observeUnexpectedSynchronousResult,
} from "./synchronous-result.js";

export interface AwsHttpResolvedDependency {
	readonly name: string;
	readonly kind: "kv" | "bucket" | "secret" | "queue" | "notify" | "crypto";
	readonly physicalName: string;
	readonly allow: readonly string[];
}
export interface AwsHttpSource {
	fetch(request: Request): Promise<Response>;
}
interface CapturedSource {
	readonly graph: AwsHttpGraph;
	readonly source: AwsHttpSource;
}
const sources = new WeakMap<object, CapturedSource>();
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor;
const own = Object.hasOwn;
const freeze = Object.freeze;
const arrayPush = Array.prototype.push;
const define = Object.defineProperty;
const NativeResponse = Response;
const responseStatus = descriptor(NativeResponse.prototype, "status")?.get;
const fallback = new NativeResponse(null, { status: 503 });
define(fallback, "then", { value: undefined });
freeze(fallback);
const unavailable = () => {
	try {
		const response = new NativeResponse(null, { status: 503 });
		if (!responseStatus || apply(responseStatus, response, []) !== 503)
			return fallback;
		define(response, "then", { value: undefined });
		return response;
	} catch {
		return fallback;
	}
};

export function defineAwsHttpSource<Requirements>(options: {
	readonly bindle: BindleForAlchemy<AwsHttpEntrypoint, Requirements>;
	readonly applicationName: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly resolveStores: (
		bindings: readonly AwsHttpResolvedDependency[],
	) => Readonly<
		Record<
			string,
			| AwsKvStore
			| AwsS3Store
			| AwsSecretStore
			| DurableQueue
			| NotificationPort
			| CryptographyPort
		>
	>;
	readonly verifyBinding: (claim: AwsHttpBindingClaim) => boolean;
}): AwsHttpSource {
	if (
		!options ||
		typeof options !== "object" ||
		types.isProxy(options) ||
		Reflect.ownKeys(options).length !== 5 ||
		[
			"bindle",
			"applicationName",
			"environment",
			"resolveStores",
			"verifyBinding",
		].some((key) => {
			const field = Object.getOwnPropertyDescriptor(options, key);
			return !field || !Object.hasOwn(field, "value") || !field.enumerable;
		}) ||
		!options.environment ||
		typeof options.environment !== "object" ||
		types.isProxy(options.environment) ||
		Array.isArray(options.environment) ||
		typeof options.resolveStores !== "function" ||
		types.isProxy(options.resolveStores) ||
		typeof options.verifyBinding !== "function" ||
		types.isProxy(options.verifyBinding)
	)
		throw new Error("invalid AWS HTTP source options");
	const { bindle, applicationName, environment, resolveStores, verifyBinding } =
		options;
	const graph = captureAwsHttpGraph(bindle, applicationName);
	let application: AwsBindleApplication | undefined;
	let resolved: readonly AwsHttpResolvedDependency[] | undefined;
	const readNames = (): readonly AwsHttpResolvedDependency[] => {
		const result: AwsHttpResolvedDependency[] = [];
		for (let index = 0; index < graph.bindings.length; index++) {
			const binding = graph.bindings[index];
			if (!binding) throw new Error("AWS resource binding is unavailable");
			const field = descriptor(environment, binding.environment);
			const physicalName =
				field && own(field, "value") ? field.value : undefined;
			if (
				typeof physicalName !== "string" ||
				physicalName.length === 0 ||
				physicalName.length > 1024 ||
				/[\p{Cc}]/u.test(physicalName)
			)
				throw new Error("AWS resource environment is unavailable");
			apply(arrayPush, result, [
				freeze({
					name: binding.name,
					kind: binding.kind,
					physicalName,
					allow: binding.allow,
				}),
			]);
		}
		return freeze(result);
	};
	const namesUnchanged = (expected: readonly AwsHttpResolvedDependency[]) => {
		const current = readNames();
		if (current.length !== expected.length) return false;
		for (let index = 0; index < current.length; index++)
			if (current[index]?.physicalName !== expected[index]?.physicalName)
				return false;
		return true;
	};
	const source: AwsHttpSource = Object.freeze({
		async fetch(request: Request): Promise<Response> {
			try {
				const current = readNames();
				if (resolved) {
					for (let i = 0; i < current.length; i++)
						if (current[i]?.physicalName !== resolved[i]?.physicalName)
							return unavailable();
				} else {
					const stores = resolveStores(current);
					if (
						!stores ||
						typeof stores !== "object" ||
						types.isProxy(stores) ||
						types.isPromise(stores) ||
						Array.isArray(stores) ||
						Reflect.ownKeys(stores).length !== current.length
					) {
						observeUnexpectedSynchronousResult(stores);
						return unavailable();
					}
					for (let index = 0; index < current.length; index++) {
						const binding = current[index];
						if (!binding) return unavailable();
						const field = descriptor(stores, binding.name);
						if (!field || !own(field, "value") || !field.enumerable)
							return unavailable();
						const queue =
							binding.kind === "queue"
								? inspectAtomicDurableQueue(field.value)
								: undefined;
						const grant =
							binding.kind === "queue"
								? queue
									? inspectAwsQueueAtomicStore(queue.store)
									: undefined
								: binding.kind === "kv"
									? inspectAwsDynamoKvStore(field.value)
									: binding.kind === "bucket"
										? inspectAwsS3Store(field.value)
										: binding.kind === "notify"
											? inspectAwsNotificationPublisher(field.value)
											: binding.kind === "crypto"
												? inspectAwsKmsCryptography(field.value)
												: inspectAwsSecretStore(field.value);
						if (
							!grant ||
							(binding.kind === "kv" || binding.kind === "queue"
								? !("tableName" in grant) ||
									grant.tableName !== binding.physicalName
								: binding.kind === "bucket"
									? !("bucketName" in grant) ||
										grant.bucketName !== binding.physicalName
									: binding.kind === "notify"
										? !("topicName" in grant) ||
											grant.topicName !== binding.physicalName
										: binding.kind === "crypto"
											? !("keyId" in grant) ||
												grant.keyId !== binding.physicalName
											: !("secretArn" in grant) ||
												grant.secretArn !== binding.physicalName)
						)
							return unavailable();
					}
					const candidate = createAwsBindleApplication({
						bindle: graph.bindle,
						applicationName,
						stores,
						verifyBinding: (claim) => {
							try {
								return (
									namesUnchanged(current) &&
									acceptSynchronousTrue(verifyBinding(claim)) &&
									namesUnchanged(current)
								);
							} catch {
								return false;
							}
						},
					});
					const after = readNames();
					for (let i = 0; i < current.length; i++)
						if (current[i]?.physicalName !== after[i]?.physicalName)
							return unavailable();
					application = candidate;
					resolved = current;
				}
				if (!application || !resolved) return unavailable();
				const response = await application.fetch(request);
				const afterResponse = readNames();
				for (let i = 0; i < afterResponse.length; i++)
					if (afterResponse[i]?.physicalName !== resolved[i]?.physicalName)
						return unavailable();
				return response;
			} catch {
				return unavailable();
			}
		},
	});
	apply(weakSet, sources, [source, Object.freeze({ source, graph })]);
	return source;
}

export function inspectAwsHttpSource(
	source: unknown,
): CapturedSource | undefined {
	if (!source || typeof source !== "object" || types.isProxy(source))
		return undefined;
	return apply(weakGet, sources, [source]);
}
