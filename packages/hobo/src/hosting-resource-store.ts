import { createHash } from "node:crypto";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	type DurableEventStore,
	type PrincipalRef,
	ProviderResourceRecordEnvelopeSchema,
	parseResourceLifecycleObservation,
	type ResourceLifecycleObservation,
	ResourceLifecycleObservationRecordSchema,
	type ResourceRecordRepository,
} from "@hobo/core";
import { isJsonObject, isJsonString, parseJsonValue } from "./json.js";

/** Provider codecs validate their own generated records. They must serialize
 * custody references, never connection strings, passwords or claim URLs. */
export function createDurableHostingResourceRepository<T>(options: {
	readonly store: DurableEventStore;
	readonly scope: {
		readonly tenantId: string;
		readonly providerId: string;
		readonly providerAccountId: string;
		readonly scopeId: string;
	};
	readonly actor: PrincipalRef;
	readonly fenceToken: bigint;
	readonly codec: {
		serialize(record: T): string;
		parse(json: string): T;
	};
	readonly nowMs?: () => number;
	readonly observationMaxAgeMs?: number;
}): ResourceRecordRepository<T> {
	const scope = Object.freeze({ ...options.scope });
	if (Object.values(scope).some((value) => !value || value.length > 2048))
		throw new Error("bounded complete hosting resource scope required");
	if (options.fenceToken < 1n)
		throw new Error("positive hosting resource owner fence required");
	const now = options.nowMs ?? Date.now;
	const maxAgeMs = options.observationMaxAgeMs ?? 300_000;
	if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1)
		throw new Error("positive resource observation age required");
	function digest(value: string) {
		return `sha256:${createHash("sha256").update(value).digest("hex")}`;
	}
	function canonical(json: string): string {
		const value = parseJsonValue(json);
		if (!isJsonObject(value))
			throw new Error("hosting resource record must be a JSON object");
		function clean(input: typeof value): typeof value {
			if (Array.isArray(input)) return input.map(clean);
			if (isJsonObject(input)) {
				const result: Record<string, typeof value> = {};
				for (const key of Object.keys(input).sort()) {
					if (
						/^(?:password|token|apiToken|accessToken|secret|connectionString|databaseUrl|redisProtocolUrl|claimUrl)$/iu.test(
							key,
						)
					)
						throw new Error(
							"hosting resource records require custody references",
						);
					const item = input[key];
					if (item === undefined)
						throw new Error("invalid JSON resource member");
					result[key] = clean(item);
				}
				return result;
			}
			if (
				isJsonString(input) &&
				(/^(?:postgres(?:ql)?|rediss?):\/\//iu.test(input) ||
					/^Bearer\s/iu.test(input))
			)
				throw new Error("hosting resource records contain credential material");
			return input;
		}
		return JSON.stringify(clean(value));
	}
	function stream(key: string, observation: boolean) {
		if (!key || key.length > 2048)
			throw new Error("bounded hosting resource key required");
		const identity = JSON.stringify([
			scope.tenantId,
			scope.providerId,
			scope.providerAccountId,
			scope.scopeId,
		]);
		return `hosting-resource:${digest(identity)}:${observation ? "observation" : "identity"}:${digest(key)}`;
	}
	async function readEnvelope(key: string, observation: boolean) {
		const streamId = stream(key, observation);
		let json: string | undefined;
		let seq = 0;
		for await (const event of options.store.read(streamId)) {
			if (
				event.tenant !== scope.tenantId ||
				event.streamId !== streamId ||
				event.seq !== seq + 1 ||
				event.type !==
					(observation
						? "hosting.ResourceObserved"
						: "hosting.ResourceRecorded")
			)
				throw new Error("foreign or inconsistent hosting resource journal");
			const entry = fromJson(
				ProviderResourceRecordEnvelopeSchema,
				JSON.parse(JSON.stringify(event.data)),
			);
			for (const field of [
				"tenantId",
				"providerId",
				"providerAccountId",
				"scopeId",
			] as const)
				if (entry[field] !== scope[field])
					throw new Error("foreign hosting resource scope");
			if (
				entry.recordKey !== key ||
				entry.recordDigest !== digest(entry.recordJson) ||
				canonical(entry.recordJson) !== entry.recordJson
			)
				throw new Error("invalid hosting resource content address");
			if (!observation && json !== undefined && json !== entry.recordJson)
				throw new Error("hosting resource identity was changed");
			if (observation && json !== undefined)
				advance(parseObservation(json), parseObservation(entry.recordJson));
			json = entry.recordJson;
			seq = event.seq;
		}
		return { json, seq };
	}
	function parseObservation(json: string, fresh = false) {
		const wire = fromJson(
			ResourceLifecycleObservationRecordSchema,
			JSON.parse(json),
		);
		return parseResourceLifecycleObservation(wire, {
			...scope,
			productId: wire.productId,
			resourceId: wire.resourceId,
			operationId: wire.operationId,
			nowMs: fresh ? now() : wire.observedAtMs,
			maxAgeMs,
		});
	}
	function advance(
		previous: ResourceLifecycleObservation,
		next: ResourceLifecycleObservation,
	) {
		if (
			previous.observedAtMs >= next.observedAtMs ||
			previous.resourceId !== next.resourceId ||
			previous.productId !== next.productId ||
			previous.operationId !== next.operationId ||
			(previous.physicalId && previous.physicalId !== next.physicalId) ||
			(previous.status === "absent" && next.status !== "absent") ||
			(previous.usageFinal &&
				(!next.usageFinal || previous.settledMicros !== next.settledMicros))
		)
			throw new Error(
				"hosting resource observation regresses or changes identity",
			);
	}
	async function append(
		key: string,
		json: string,
		observation: boolean,
		seq: number,
	) {
		const envelope = create(ProviderResourceRecordEnvelopeSchema, {
			...scope,
			recordKey: key,
			recordJson: json,
			recordDigest: digest(json),
		});
		await options.store.commit({
			streamId: stream(key, observation),
			append: {
				expectedSeq: seq,
				tenant: scope.tenantId,
				actor: options.actor,
				fenceToken: options.fenceToken,
			},
			events: [
				{
					type: observation
						? "hosting.ResourceObserved"
						: "hosting.ResourceRecorded",
					data: toJson(ProviderResourceRecordEnvelopeSchema, envelope),
				},
			],
		});
	}
	async function write(key: string, json: string, observation: boolean) {
		for (let attempt = 0; attempt < 8; attempt++) {
			const current = await readEnvelope(key, observation);
			if (current.json === json) return;
			if (current.json !== undefined) {
				if (!observation)
					throw new Error(
						"hosting resource identity already recorded with different content",
					);
				advance(parseObservation(current.json), parseObservation(json, true));
			}
			try {
				await append(key, json, observation, current.seq);
				return;
			} catch (error) {
				const observed = await readEnvelope(key, observation);
				if (observed.json === json) return;
				if (observed.seq <= current.seq || attempt === 7) throw error;
			}
		}
	}
	return {
		persistence: "durable-cas",
		async read(key) {
			const result = await readEnvelope(key, false);
			return result.json === undefined
				? undefined
				: options.codec.parse(result.json);
		},
		async write(key, record) {
			const json = canonical(options.codec.serialize(record));
			if (
				canonical(options.codec.serialize(options.codec.parse(json))) !== json
			)
				throw new Error("provider resource codec does not roundtrip");
			await write(key, json, false);
		},
		async readObservation(key) {
			const result = await readEnvelope(key, true);
			return result.json === undefined
				? undefined
				: parseObservation(result.json);
		},
		async writeObservation(key, observation) {
			const parsed = parseResourceLifecycleObservation(observation, {
				...scope,
				productId: observation.productId,
				resourceId: observation.resourceId,
				operationId: observation.operationId,
				nowMs: now(),
				maxAgeMs,
			});
			await write(
				key,
				canonical(
					JSON.stringify(
						toJson(ResourceLifecycleObservationRecordSchema, parsed),
					),
				),
				true,
			);
		},
	};
}
