import type { JournalMemberProvisioner } from "@hobo/hobo-cd";
import { createFetchTransport, createNeonClient } from "@hobo/provider-neon";

import {
	type DurableClaimStore,
	secretStoreClaims,
} from "./secret-store-claims.js";

// The databases `hobo cd up` creates for the CD journal's fleet.
//
// Neon Claimable Postgres (`@hobo/provider-neon`): an unauthenticated create,
// so provisioning needs no account and no key. Every such database is in one
// region of one vendor (Postgres 17, AWS us-east-2, per Neon's documentation),
// so members on it alone do not spread across failure domains, which the
// fleet's continuity shortfalls say when it opens; a provisioner for another
// vendor joins this list to change that. An unclaimed database expires: its
// claim link is kept in the owner's store, and claiming keeps the connection
// string working.

/** Neon Claimable Postgres as a journal member provisioner. */
export function neonJournalProvisioner(
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
	/** Test seam: the claim store; by default the owner's store (`secret-store-claims.ts`). */
	claims?: (
		store: Parameters<JournalMemberProvisioner["create"]>[0]["store"],
	) => DurableClaimStore,
): JournalMemberProvisioner {
	return {
		plan: "neon-claimable",
		...(claims === undefined
			? { requiredOwnerStoreCapability: "atomic-create" as const }
			: undefined),
		async create({ idempotencyKey, store: owner }) {
			// Neon has no server-side idempotency. An in-memory claim cannot
			// prevent a second process or a retry after a crash from creating
			// another anonymous database and losing the first credential, so
			// the claim is kept in the owner's store, made with its atomic
			// create; a store without one is refused (the error says so).
			const store = (
				claims ??
				((opened) =>
					secretStoreClaims(opened, { prefix: "HOBO_CD_JOURNAL_CLAIM_" }))
			)(owner);
			const client = createNeonClient({
				transport: createFetchTransport({ fetchImpl }),
				store,
				clock: () => Date.now(),
			});
			const { response } = await client.createDatabase({
				ref: "hobo-cd",
				idempotencyKey,
			});
			if (response.connectionString === null)
				throw new Error(
					"Neon returned a database that was already claimed, without its connection string",
				);
			return {
				connectionString: response.connectionString,
				claimUrl: response.claimUrl,
			};
		},
	};
}

/** The provisioners `hobo cd up` uses by default. */
export function defaultJournalProvisioners(): readonly JournalMemberProvisioner[] {
	return [neonJournalProvisioner()];
}
