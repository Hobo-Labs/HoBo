import type { JournalMemberProvisioner } from "@hobo/hobo-cd";
import {
	createFetchTransport,
	createInMemoryIdempotencyStore,
	createNeonClient,
} from "@hobo/provider-neon";

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
): JournalMemberProvisioner {
	const client = createNeonClient({
		transport: createFetchTransport({ fetchImpl }),
		// One run's retries; across runs the store's entries are the record.
		store: createInMemoryIdempotencyStore(),
		clock: () => Date.now(),
	});
	return {
		plan: "neon-claimable",
		async create({ idempotencyKey }) {
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
