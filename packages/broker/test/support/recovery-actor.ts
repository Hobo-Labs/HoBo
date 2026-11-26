import {
	asBigInt,
	asNumber,
	asText,
	createMemoryNodeSqliteDriver,
	SqliteJournal,
} from "@hobo/storage-sqlite";

/** Local durable actor fixture. Production installs a shared actor authority. */
export function createRecoveryActorFixture(now: string) {
	const driver = createMemoryNodeSqliteDriver();
	const journal = new SqliteJournal(driver, {
		clock: { now: () => now },
		nativePragmas: false,
	});
	return {
		host: {
			async acquire(key: string, request: { holderId: string }) {
				const lease = journal.acquireActorLease({
					key,
					holderId: request.holderId,
				});
				return {
					...lease,
					async revalidate() {
						const row = driver
							.prepare(
								"SELECT holder_id, fence_token, expires_at, released FROM actor_leases WHERE lease_key = ?",
							)
							.get(key);
						if (
							!row ||
							asText(row.holder_id, "holder") !== request.holderId ||
							asBigInt(row.fence_token, "fence") !== lease.fenceToken ||
							asNumber(row.released, "released") !== 0 ||
							Date.parse(asText(row.expires_at, "expiry")) <= Date.parse(now)
						)
							throw new Error("stale actor lease");
					},
					async release() {
						journal.releaseActorLease(key, request.holderId, lease.fenceToken);
					},
				};
			},
		},
		close() {
			journal.close();
		},
	};
}
