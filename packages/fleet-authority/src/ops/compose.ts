// The operations' composition from the configuration (both profiles): the
// event store (SQLite through @hobo/runtime-local, or the FLEET_JOURNAL store),
// the authority bus, and the journal archiver. Private to L27.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	type AuthorityBus,
	type FleetEventStore,
	type Outcome,
	type TrustRecord,
	TrustRecordSchema,
} from "@hobo/fleet";
import { connectAuthorityBus, createJournalEventStore } from "@hobo/fleet-nats";
import {
	createRuntimeLocalEventStore,
	defaultDbPath,
} from "@hobo/runtime-local";
import type { JournalArchiver } from "./archive.js";
import type { OpsConfig } from "./config.js";
import type { OpsContext } from "./index.js";
import type { NatsSigningKeys } from "./rotation.js";
import { readSecret } from "./slots.js";

export type Composed = Readonly<{
	store(): Promise<FleetEventStore>;
	bus: AuthorityBus;
	journal: JournalArchiver;
	nats: NatsSigningKeys;
	close(): Promise<void>;
}>;

/** The standalone profile's archiver: a consistent snapshot of the SQLite journal (`VACUUM INTO`). */
export function sqliteArchiver(dbPath: string): JournalArchiver {
	const marker = `${dbPath}.restored`;
	return {
		format: "sqlite",
		async dump() {
			const copy = `${dbPath}.backup-${process.pid}-${Date.now()}`;
			const db = new DatabaseSync(dbPath, { readOnly: true });
			try {
				db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
			} finally {
				db.close();
			}
			try {
				return new Uint8Array(await readFile(copy));
			} finally {
				await rm(copy, { force: true });
			}
		},
		async load(bytes, manifestDigest) {
			if (existsSync(dbPath)) {
				const done = existsSync(marker)
					? (await readFile(marker, "utf8")).trim()
					: "";
				return done === manifestDigest
					? { ok: true, value: undefined }
					: {
							ok: false,
							error: {
								code: "conflict",
								message: `${dbPath} exists; restore needs a fresh deployment`,
							},
						};
			}
			await mkdir(dirname(dbPath), { recursive: true });
			await writeFile(`${dbPath}.partial`, bytes, { mode: 0o600 });
			await rename(`${dbPath}.partial`, dbPath);
			await writeFile(marker, manifestDigest, "utf8");
			return { ok: true, value: undefined };
		},
	};
}

/** The high-availability profile's archiver: every envelope of FLEET_JOURNAL in `readAll` order. */
export function jsonlArchiver(
	store: () => Promise<FleetEventStore>,
): JournalArchiver {
	return {
		format: "jsonl",
		async dump() {
			const lines: string[] = [];
			for await (const { event } of (await store()).readAll())
				lines.push(JSON.stringify(event));
			return new TextEncoder().encode(lines.join("\n"));
		},
		async load(): Promise<Outcome<void>> {
			// A JetStream stream restore keeps every envelope as written; the journal
			// store's port can only append new envelopes (cascade delta to L36).
			return {
				ok: false,
				error: {
					code: "unavailable",
					message:
						"restoring FLEET_JOURNAL needs a stream restore the journal store does not offer yet; restore the stream with the NATS tools, then run restore again",
				},
			};
		},
	};
}

/** NATS signing-key publication needs the account JWT, which @hobo/fleet-nats derives from the operator signing seed (cascade delta to L08). */
const NATS_UNPUBLISHED: NatsSigningKeys = {
	async publish(which) {
		return {
			ok: false,
			error: {
				code: "unavailable",
				message: `publishing the ${which} signing keys needs an account-JWT entry point in @hobo/fleet-nats; the key is added but not yet published`,
			},
		};
	},
};

export async function compose(
	context: OpsContext,
	config: OpsConfig,
): Promise<Outcome<Composed>> {
	const credentials = await readSecret(
		context.secrets,
		config.natsCredentialsSecret,
	);
	if (!credentials.ok) return credentials;
	if (credentials.value === undefined)
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: `no NATS credentials in ${config.natsCredentialsSecret}`,
			},
		};
	let bus: AuthorityBus | undefined;
	const trust = (): TrustRecord => {
		const payload = bus?.registry.trustEnvelope()?.authority?.payload;
		return payload === undefined
			? create(TrustRecordSchema)
			: fromBinary(TrustRecordSchema, payload);
	};
	bus = await connectAuthorityBus({
		servers: config.natsUrls,
		credentials: credentials.value,
		trust,
		log: context.log,
	});
	await bus.registry.caughtUp();
	const connected = bus;

	if (config.profile === "standalone") {
		const dbPath = defaultDbPath(config.dataDir);
		let opened: ReturnType<typeof createRuntimeLocalEventStore> | undefined;
		return {
			ok: true,
			value: {
				async store() {
					opened ??= createRuntimeLocalEventStore({
						dataDir: config.dataDir,
						dbPath,
						clock: { now: () => new Date(context.now()).toISOString() },
					});
					return opened;
				},
				bus: connected,
				journal: sqliteArchiver(dbPath),
				nats: NATS_UNPUBLISHED,
				async close() {
					opened?.close();
					await connected.close();
				},
			},
		};
	}
	let journal: Promise<FleetEventStore> | undefined;
	const store = () => {
		journal ??= createJournalEventStore({
			servers: config.natsUrls,
			credentials: credentials.value ?? "",
		});
		return journal;
	};
	return {
		ok: true,
		value: {
			store,
			bus: connected,
			journal: jsonlArchiver(store),
			nats: NATS_UNPUBLISHED,
			async close() {
				await connected.close();
			},
		},
	};
}
