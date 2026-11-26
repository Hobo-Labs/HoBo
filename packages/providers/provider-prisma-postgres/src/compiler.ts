/**
 * The pure compiler: capability requirement + placement → provision operation.
 *
 * "Pure" is a checked property, not an aspiration. This module reads no clock,
 * opens no socket, generates no randomness, touches no environment variable and
 * no file. Everything variable — the instant, the idempotency key, the region a
 * policy chose — arrives as an argument. `test/compiler.test.ts` asserts the
 * same inputs produce a deeply equal operation on every call.
 *
 * That matters because the operation is what a plan records and a receipt is
 * signed over. A compiler that quietly consulted `Date.now()` would produce a
 * different plan every time it ran, and the diff a reviewer sees before
 * approving a deploy would be noise.
 */
import type { PrismaProvisionOperation as PrismaProvisionOperationWire } from "./_generated/provider_prisma_postgres_pb.js";
import { buildCreateDbArgv, PRISMA_REGIONS, type PrismaRegion } from "./cli.js";
import {
	PRISMA_DEFINITION_ID,
	PRISMA_DOCUMENTED_TTL_HOURS,
	PRISMA_PROVIDER_ID,
} from "./driver.js";
import { PrismaProviderError } from "./errors.js";
import {
	PRISMA_BOOTSTRAP_STRATEGY_REF,
	PRISMA_CLAIM_STRATEGY_REF,
	PRISMA_COMPILER_REF,
	PRISMA_EXECUTOR_REF,
} from "./semantics.js";
import type { DomainView } from "./wire.js";

/**
 * The requirement as this compiler needs to see it.
 *
 * Structurally a subset of `CapabilityRequirement` from
 * `@hobo/capability-profiles`, so a parsed requirement can be passed straight
 * in. Only the parts a Prisma provision can actually honour are read; anything
 * this product cannot satisfy is refused rather than dropped.
 */
export type CompilableRequirement = {
	readonly requiredProfiles: readonly {
		readonly profileId: string;
		readonly versionRange: string;
	}[];
	readonly requiredFeatures?: Readonly<
		Record<string, boolean | number | string | readonly string[]>
	>;
	readonly preferredFeatures?: Readonly<
		Record<string, boolean | number | string | readonly string[]>
	>;
};

export type PrismaPlacement = {
	/** Chosen upstream by policy or residency; never geolocated here. */
	readonly region: PrismaRegion;
	readonly resourceRef: string;
	readonly idempotencyKey: string;
	/**
	 * `30m` or `1h`–`24h`, exactly as the pinned CLI's `--ttl` accepts. Absent
	 * means the CLI default, which is 24 hours.
	 */
	readonly ttl?: string;
	/** Identifies the calling tool to the provider. Optional, non-secret. */
	readonly userAgent?: string;
};

// domain-view: `kind`, the compiler/executor/strategy refs, the region, and the
// output mode are literal types here, so an operation naming the wrong executor
// or an unsupported region fails to compile rather than failing a CUE check
// after it has already been reviewed.
export type PrismaProvisionOperation = DomainView<
	PrismaProvisionOperationWire,
	{
		schemaVersion: "hobo.provider-prisma-postgres.provision-operation/v1";
		kind: "provision";
		definitionId: typeof PRISMA_DEFINITION_ID;
		providerId: typeof PRISMA_PROVIDER_ID;
		compilerRef: typeof PRISMA_COMPILER_REF;
		executorRef: typeof PRISMA_EXECUTOR_REF;
		bootstrapStrategyRef: typeof PRISMA_BOOTSTRAP_STRATEGY_REF;
		claimStrategyRef: typeof PRISMA_CLAIM_STRATEGY_REF;
		region: PrismaRegion;
		/** The exact argv the executor will run. Reviewable before it runs. */
		argv: readonly string[];
		outputMode: "json";
		requestedTtl?: string;
		producesBindingProfiles: readonly string[];
		expectedSecretPurpose: "connection-string";
	}
>;

const TTL = /^(?:30m|(?:1[0-9]|2[0-4]|[1-9])h)$/u;
const RESOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

const SUPPORTED_PROFILES = new Set(["data.postgres/v1", "data.relational/v1"]);

/**
 * Features this product can actually promise. A required feature outside this
 * set is refused at compile time, where the message can name the gap, rather
 * than at execution time, where it looks like a provider outage.
 */
const HONOURABLE_FEATURES = new Set([
	"postgresWireProtocol",
	"tls",
	"transactions",
	"constraints",
	"jsonDocuments",
	"preparedStatements",
	"pooling",
	"connectionUriBinding",
	"ddl",
	"transactionRollback",
]);

function refuse(
	message: string,
	detail?: Record<string, string | number>,
): never {
	throw new PrismaProviderError("PROVIDER_CONTRACT_CHANGED", message, {
		...(detail !== undefined ? { detail } : undefined),
	});
}

/**
 * Compile a requirement and a placement into one provision operation.
 *
 * The result contains the literal argv. That is deliberate: a reviewer reading
 * a plan should be able to see the exact third-party command that will run,
 * including the pinned version, without running anything.
 */
export function compilePrismaProvision(
	requirement: CompilableRequirement,
	placement: PrismaPlacement,
): PrismaProvisionOperation {
	if (requirement.requiredProfiles.length === 0) {
		refuse(
			"a provision operation needs at least one required capability profile",
		);
	}
	for (const profile of requirement.requiredProfiles) {
		if (!SUPPORTED_PROFILES.has(profile.profileId)) {
			refuse(
				`prisma.claimable-postgres/v1 does not implement ${profile.profileId}; matching should not have selected it`,
				{ profileId: profile.profileId },
			);
		}
	}
	for (const key of Object.keys(requirement.requiredFeatures ?? {})) {
		if (!HONOURABLE_FEATURES.has(key)) {
			refuse(
				`the temporary Prisma Postgres tier documents nothing about the required feature \`${key}\`, so it cannot be compiled into a provision`,
				{ feature: key },
			);
		}
	}
	if (!PRISMA_REGIONS.includes(placement.region)) {
		refuse(
			`region ${String(placement.region)} is not one the pinned create-db CLI accepts`,
		);
	}
	if (!RESOURCE_REF.test(placement.resourceRef)) {
		refuse("resourceRef must be 3-256 reference characters");
	}
	if (!IDEMPOTENCY_KEY.test(placement.idempotencyKey)) {
		refuse("idempotencyKey must be 8-128 identifier characters");
	}
	if (placement.ttl !== undefined && !TTL.test(placement.ttl)) {
		refuse(`ttl ${JSON.stringify(placement.ttl)} is not one of 30m or 1h-24h`);
	}

	const invocation = buildCreateDbArgv({
		region: placement.region,
		json: true,
		...(placement.ttl !== undefined ? { ttl: placement.ttl } : undefined),
		...(placement.userAgent !== undefined
			? { userAgent: placement.userAgent }
			: undefined),
	});

	return {
		schemaVersion: "hobo.provider-prisma-postgres.provision-operation/v1",
		kind: "provision",
		definitionId: PRISMA_DEFINITION_ID,
		providerId: PRISMA_PROVIDER_ID,
		compilerRef: PRISMA_COMPILER_REF,
		executorRef: PRISMA_EXECUTOR_REF,
		bootstrapStrategyRef: PRISMA_BOOTSTRAP_STRATEGY_REF,
		claimStrategyRef: PRISMA_CLAIM_STRATEGY_REF,
		resourceRef: placement.resourceRef,
		idempotencyKey: placement.idempotencyKey,
		region: placement.region,
		argv: invocation.argv,
		timeoutMs: invocation.timeoutMs,
		maxOutputBytes: invocation.maxOutputBytes,
		outputMode: "json",
		documentedTtlHours: PRISMA_DOCUMENTED_TTL_HOURS,
		...(placement.ttl !== undefined
			? { requestedTtl: placement.ttl }
			: undefined),
		producesBindingProfiles: ["binding.postgresql/v1"],
		expectedSecretPurpose: "connection-string",
	};
}
