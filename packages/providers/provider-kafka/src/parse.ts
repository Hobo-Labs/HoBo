import { MessagingParseError, parseDeliveryGuarantee } from "@hobo/core";

import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import type {
	KafkaClusterKind,
	KafkaClusterSpec,
	KafkaResourceDefinition,
	KafkaTopicResource,
} from "./types.js";

function isKafkaClusterKind(value: string): value is KafkaClusterKind {
	switch (value) {
		case "self-hosted":
		case "redpanda":
		case "msk":
		case "confluent":
		case "azure-event-hubs":
		case "local-emulator":
			return true;
		default:
			return false;
	}
}

function nonEmpty(value: JsonValue | undefined, field: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new MessagingParseError(field, "non-empty string", value);
	}
	return value;
}

export function parseKafkaClusterKind(
	value: JsonValue | undefined,
): KafkaClusterKind {
	if (!isJsonString(value) || !isKafkaClusterKind(value)) {
		throw new MessagingParseError(
			"kind",
			"self-hosted|redpanda|msk|confluent|azure-event-hubs|local-emulator",
			value,
		);
	}
	return value;
}

export function parseKafkaClusterSpec(input: JsonValue): KafkaClusterSpec {
	if (!isJsonObject(input)) {
		throw new MessagingParseError("KafkaClusterSpec", "object", input);
	}
	const src = input;
	const serversRaw = src.bootstrapServers ?? src.bootstrap_servers;
	const servers = isJsonArray(serversRaw)
		? serversRaw.map((s) => nonEmpty(s, "bootstrapServers[]"))
		: [];
	const kind = parseKafkaClusterKind(src.kind ?? "self-hosted");
	const credentialBindingRef = nonEmpty(
		src.credentialBindingRef ??
			src.credential_binding_ref ??
			"fromBinding:kafka",
		"credentialBindingRef",
	);
	for (const forbidden of [
		"password",
		"saslPassword",
		"apiSecret",
		"secretAccessKey",
		"plaintextCredential",
	] as const) {
		if (forbidden in src) {
			throw new MessagingParseError(
				forbidden,
				"absent (secretless-first)",
				src[forbidden],
			);
		}
	}
	const labels = isJsonObject(src.labels) ? src.labels : undefined;
	const labelMap: { [key: string]: string } = {};
	if (labels !== undefined) {
		for (const [key, entry] of Object.entries(labels)) {
			if (isJsonString(entry)) labelMap[key] = entry;
		}
	}
	return Object.freeze({
		name: nonEmpty(src.name, "name"),
		tenantId: nonEmpty(src.tenantId ?? src.tenant_id, "tenantId"),
		kind,
		bootstrapServers: servers,
		credentialBindingRef,
		transactional: src.transactional === true,
		idempotentProducer:
			src.idempotentProducer === true ||
			src.idempotent_producer === true ||
			(src.idempotentProducer === undefined &&
				src.idempotent_producer === undefined),
		...(isJsonString(src.schemaRegistryRef)
			? { schemaRegistryRef: src.schemaRegistryRef }
			: isJsonString(src.schema_registry_ref)
				? { schemaRegistryRef: src.schema_registry_ref }
				: undefined),
		...(Object.keys(labelMap).length > 0 ? { labels: labelMap } : undefined),
	});
}

export function parseKafkaTopicResource(input: JsonValue): KafkaTopicResource {
	if (!isJsonObject(input)) {
		throw new MessagingParseError("KafkaTopicResource", "object", input);
	}
	const src = input;
	const delivery = parseDeliveryGuarantee(
		src.deliveryGuarantee ?? src.delivery_guarantee ?? "at-least-once",
	);
	const partitions = Number(src.partitions ?? 1);
	const rf = Number(src.replicationFactor ?? src.replication_factor ?? 1);
	if (!Number.isInteger(partitions) || partitions < 1) {
		throw new MessagingParseError("partitions", "int >= 1", src.partitions);
	}
	if (!Number.isInteger(rf) || rf < 1) {
		throw new MessagingParseError("replicationFactor", "int >= 1", rf);
	}
	return Object.freeze({
		name: nonEmpty(src.name, "name"),
		cluster: nonEmpty(src.cluster, "cluster"),
		tenantId: nonEmpty(src.tenantId ?? src.tenant_id, "tenantId"),
		partitions,
		replicationFactor: rf,
		deliveryGuarantee: delivery,
		...(isJsonString(src.deadLetterTopic)
			? { deadLetterTopic: src.deadLetterTopic }
			: isJsonString(src.dead_letter_topic)
				? { deadLetterTopic: src.dead_letter_topic }
				: undefined),
		...(isJsonString(src.schemaRef)
			? { schemaRef: src.schemaRef }
			: isJsonString(src.schema_ref)
				? { schemaRef: src.schema_ref }
				: undefined),
	});
}

export function parseKafkaResourceDefinition(
	input: JsonValue,
): KafkaResourceDefinition {
	if (!isJsonObject(input)) {
		throw new MessagingParseError("KafkaResourceDefinition", "object", input);
	}
	const src = input;
	const apiVersion = nonEmpty(src.apiVersion ?? src.api_version, "apiVersion");
	if (apiVersion !== "hobo.kafka/v1") {
		throw new MessagingParseError("apiVersion", "hobo.kafka/v1", apiVersion);
	}
	const kind = nonEmpty(src.kind, "kind");
	if (kind !== "KafkaCluster" && kind !== "KafkaTopic") {
		throw new MessagingParseError("kind", "KafkaCluster|KafkaTopic", kind);
	}
	const metadata = isJsonObject(src.metadata) ? src.metadata : undefined;
	const name = nonEmpty(src.name ?? metadata?.name, "name");
	const tenantId = nonEmpty(
		src.tenantId ?? src.tenant_id ?? metadata?.tenantId,
		"tenantId",
	);
	const body = src.spec ?? src;
	const merged: JsonObject = isJsonObject(body)
		? { ...body, name, tenantId }
		: { name, tenantId };
	const spec =
		kind === "KafkaCluster"
			? parseKafkaClusterSpec(merged)
			: parseKafkaTopicResource(merged);
	return Object.freeze({
		apiVersion: "hobo.kafka/v1" as const,
		kind,
		name,
		tenantId,
		spec,
	});
}
