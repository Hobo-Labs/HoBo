/**
 * The default AWS Yard catalog: what AWS *can* allocate, per slot.
 *
 * A Yard declares allocatable capacity. It is not a mapping, not a pool, not a
 * selection, and not a record of what an app uses — so a slot holds a *list*,
 * and several entries in one slot are the normal case, with selection
 * (ADR-0151) picking among them later against the requirements the app
 * actually states. Collapsing a slot to a single value would quietly make this
 * module the selector, which is exactly the decision the Yard is not allowed to
 * take.
 *
 * HONEST SCOPE — how full this catalog is: it is built strictly from the typed
 * factories `./slots.ts` ships, which today are `s3`, `rds.postgres`,
 * `dynamodb`, `sqs`, `eks.deployment` and `lambda`. That is one entry per slot.
 * AWS obviously offers more than one way to host a web app or store a
 * document; those alternatives are simply not authored yet, so this catalog
 * under-declares AWS rather than mis-declaring it. A missing alternative is a
 * gap in the factory set, not a choice made here.
 *
 * `awsYardSpec()` emits raw row-shaped data rather than a `Yard`: this is a
 * layer-2 provider package, so it may import `@hobo/core` and nothing else
 * HoBo — `@hobo/yards` (layer 3) is the package that parses these rows into a
 * canonical, deduplicated set. The rows are sorted by
 * `(profile, productId, connectivityId)`, the same canonical order
 * `parseYardBindings` imposes, so the hand-off is byte-stable.
 *
 * Determinism: no clock, no randomness, no environment reads. Two calls with
 * the same options are deep-equal.
 *
 * HONEST SCOPE — what deploys: still nothing. This is the catalog, meaning
 * what AWS is *able* to allocate (ADR-0157 decision 1), not what is allocated.
 * This package registers no Resource Definitions for the `aws.*` product ids,
 * so a deploy attempted against this Yard fails closed at resolution
 * (`YARD_BINDING_PRODUCT_UNKNOWN`) until definitions land. It does now ship
 * SigV4-signed resolvers for 8 of the 19 ids
 * (`AWS_RESOLVED_PRODUCT_IDS`), and those are proven against an injected fake
 * transport — no live AWS call has been made from this repo.
 */
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

/** Allocatable options per capability slot; a slot may hold several. */
export type AwsSlotCatalog = Readonly<
	Partial<Record<CapabilitySlot, readonly SlotBinding[]>>
>;

/** Row shape `@hobo/yards` parses (`YardBindingInput`), without importing it. */
export interface AwsYardBindingRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

/** Raw Yard shape: provider, regions, and the allocatable row set. */
export interface AwsYardSpec {
	readonly provider: "aws";
	readonly regions: readonly string[];
	readonly bindings: readonly AwsYardBindingRow[];
}

export interface AwsYardSpecOptions {
	readonly regions?: readonly string[];
}

/**
 * Everything the AWS factories can allocate, grouped by slot. Several entries
 * per slot are the normal case, not a conflict to be resolved here: AWS really
 * does host a web capability on App Runner, ECS, EKS and Amplify, and really
 * does satisfy `data` with RDS, Aurora and DynamoDB. Collapsing a slot to one
 * entry would quietly make this module the selector, which is exactly the
 * decision the Yard is not allowed to take.
 *
 * `web` mixes two profiles on purpose. `cloudfrontSite()` satisfies the
 * narrower `web.static/v1`, the other four satisfy `web.hosted/v1`; a workload
 * that only needs static hosting can match either, and one that needs a running
 * server matches only the hosted rows. Selection sorts that out per resource.
 */
export const AWS_DEFAULT_BINDINGS: AwsSlotCatalog = Object.freeze({
	web: Object.freeze([
		appRunner(),
		ecs.service(),
		eks.deployment(),
		amplifyHosting(),
		cloudfrontSite(),
	]),
	api: Object.freeze([apiGateway()]),
	service: Object.freeze([lambda(), ecs.task()]),
	data: Object.freeze([
		rds.postgres(),
		rds.mysql(),
		auroraServerlessPostgres(),
		dynamodbDocument(),
	]),
	kv: Object.freeze([dynamodb(), elasticacheRedis()]),
	bucket: Object.freeze([s3()]),
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

/**
 * Flattens the slot catalog into the canonical row order
 * `(profile, productId, connectivityId)` — the same order `@hobo/yards`
 * imposes, so a round-trip through it does not reshuffle the set. The slot
 * itself is not a row field: rows key on the capability profile.
 */
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

/** Code-unit comparison: locale-independent so ordering is reproducible. */
function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
