import type { CapabilitySlot, SlotBinding } from "@hobo/core";

import { type JsonObject, parseJsonObject } from "./json.js";

import { DEFAULT_REGIONS } from "./manifest.js";
import {
	amplifyHosting,
	apiGateway,
	appRunner,
	auroraServerlessPostgres,
	cloudfrontSite,
	dynamodb,
	dynamodbDocument,
	ebsVolume,
	ec2Instance,
	ecs,
	eks,
	elasticacheRedis,
	lambda,
	rds,
	s3,
	secretsManager,
	sns,
	sqs,
	sqsFifo,
	ssmParameterStore,
} from "./slots.js";

export type AwsSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

export interface AwsYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

export interface AwsYardSpec {
	readonly provider: "aws";
	readonly regions: readonly string[];
	readonly bindings: readonly AwsYardBindingRow[];
}

export interface AwsYardSpecOptions {
	readonly regions?: readonly string[];
}

export const AWS_DEFAULT_BINDINGS: AwsSlotCatalog = Object.freeze({
	web: Object.freeze([
		appRunner(),
		ecs.service(),
		eks.deployment(),
		amplifyHosting(),
		cloudfrontSite(),
	]),
	api: Object.freeze([apiGateway()]),
	service: Object.freeze([ec2Instance(), lambda(), ecs.task()]),
	data: Object.freeze([
		rds.postgres(),
		rds.mysql(),
		auroraServerlessPostgres(),
		dynamodbDocument(),
	]),
	kv: Object.freeze([dynamodb(), elasticacheRedis()]),
	bucket: Object.freeze([ebsVolume(), s3()]),
	queue: Object.freeze([sqs(), sqsFifo()]),
	topic: Object.freeze([sns()]),
	secretRef: Object.freeze([secretsManager(), ssmParameterStore()]),
});

/**
 * The default AWS Yard as raw rows. `regions` defaults to the provider's
 * published regions; the catalog is not narrowed by region, because a Yard
 * declares what the provider can allocate, not what a particular region
 * happens to offer.
 */
export function awsYardSpec(options?: AwsYardSpecOptions): AwsYardSpec {
	return Object.freeze({
		provider: "aws",
		regions: Object.freeze([...(options?.regions ?? DEFAULT_REGIONS)]),
		bindings: toRows(AWS_DEFAULT_BINDINGS),
	});
}

function toRows(catalog: AwsSlotCatalog): readonly AwsYardBindingRow[] {
	const rows: AwsYardBindingRow[] = [];
	for (const bindings of Object.values(catalog)) {
		for (const binding of bindings ?? []) {
			rows.push(
				Object.freeze({
					profile: binding.profile,
					...(binding.productId !== undefined
						? { productId: binding.productId }
						: undefined),
					...(binding.connectivityId !== undefined
						? { connectivityId: binding.connectivityId }
						: undefined),
					properties: parseJsonObject(JSON.stringify(binding.properties)),
				}),
			);
		}
	}
	rows.sort(
		(left, right) =>
			compare(left.profile, right.profile) ||
			compare(left.productId ?? "", right.productId ?? "") ||
			compare(left.connectivityId ?? "", right.connectivityId ?? ""),
	);
	return Object.freeze(rows);
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
