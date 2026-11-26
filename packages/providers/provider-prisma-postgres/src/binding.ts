/**
 * The portable binding emitted by a Prisma Postgres claimable database.
 *
 * One endpoint, one profile: `binding.postgresql/v1`. Prisma Postgres speaks
 * the PostgreSQL wire protocol through `db.prisma.io`, so there is nothing
 * provider-specific for a workload to consume and no second binding profile to
 * invent.
 */
import {
	type CapabilityBinding,
	type CapabilityBindingInput,
	type NonSecretEndpointRef,
	type ParsedSecretRef,
	parseCapabilityBinding,
	parseSecretRef,
} from "@hobo/bindings";

import { PrismaProviderError } from "./errors.js";

export const PRISMA_BINDING_PROFILES = ["binding.postgresql/v1"] as const;

export type BuildBindingInput = {
	readonly bindingId: string;
	readonly resourceRef: string;
	readonly endpoint: NonSecretEndpointRef;
	readonly credentialRef: ParsedSecretRef;
	readonly expiresAtMs?: number;
	readonly producerEvidenceRef: string;
	readonly databaseName: string;
	readonly projectId: string;
	readonly region: string;
};

export function buildPrismaCapabilityBinding(
	input: BuildBindingInput,
): CapabilityBinding {
	const binding: CapabilityBindingInput = {
		schemaVersion: "hobo.capability-binding/v1",
		id: input.bindingId,
		resourceRef: input.resourceRef,
		capabilityProfileRef: "data.postgres/v1",
		bindingProfileRef: "binding.postgresql/v1",
		type: "postgresql",
		provider: "prisma",
		endpoints: [
			{ protocol: "postgresql", addressRef: input.endpoint, role: "primary" },
		],
		credentialRef: input.credentialRef.ref,
		metadataRefs: {
			databaseName: input.databaseName,
			projectId: input.projectId,
			region: input.region,
		},
		...(input.expiresAtMs !== undefined
			? { expiresAtMs: input.expiresAtMs }
			: undefined),
		renewable: false,
		// Undocumented for the claimable tier, so declared false rather than
		// promised. See the README's "Not verified" section.
		rotationSupported: false,
		revocationSupported: false,
		producerEvidenceRef: input.producerEvidenceRef,
	};

	try {
		return parseCapabilityBinding(binding, parseSecretRef);
	} catch (cause) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the claimable database did not produce a valid portable binding",
			{ cause: cause instanceof Error ? cause : new Error(String(cause)) },
		);
	}
}
