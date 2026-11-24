import type { DatabaseSync } from "node:sqlite";
import { create, toJsonString } from "@bufbuild/protobuf";
import { z } from "zod";
import {
	type MachineAdvert,
	MachineAdvertSchema,
} from "../_generated/relay_job_pb.js";
import { MachineRegistryError } from "./machine-registry.js";
import type { MachineSharing } from "./machines.js";
import type { MachineRegistry } from "./ports.js";
import { defineMachineAdvert, parseMachineAdvert } from "./relay-job.js";

export { MachineRegistryError };

const MachineRow = z.object({ body: z.string() });

export class SqliteMachineRegistry implements MachineRegistry {
	constructor(private readonly db: DatabaseSync) {
		db.exec(`CREATE TABLE IF NOT EXISTS ci_machines (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			body TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS ci_machines_account ON ci_machines(account_id, id);`);
	}

	private atomic<T>(work: () => T): Promise<T> {
		try {
			this.db.exec("BEGIN IMMEDIATE");
			try {
				const result = work();
				this.db.exec("COMMIT");
				return Promise.resolve(result);
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
		} catch (error) {
			return Promise.reject(error);
		}
	}

	private read(id: string): MachineAdvert | undefined {
		const row = this.db
			.prepare("SELECT body FROM ci_machines WHERE id = ?")
			.get(id);
		return row === undefined
			? undefined
			: parseMachineAdvert(MachineRow.parse(row).body);
	}

	private write(advert: MachineAdvert): void {
		this.db
			.prepare(
				"INSERT INTO ci_machines(id, account_id, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, body = excluded.body",
			)
			.run(
				advert.id,
				advert.accountId,
				toJsonString(MachineAdvertSchema, advert),
			);
	}

	private known(id: string): MachineAdvert {
		const machine = this.read(id);
		if (!machine)
			throw new MachineRegistryError("unknown_machine", `no machine ${id}`);
		return machine;
	}

	list(accountId: string): Promise<readonly MachineAdvert[]> {
		try {
			return Promise.resolve(
				this.db
					.prepare(
						"SELECT body FROM ci_machines WHERE account_id = ? ORDER BY id",
					)
					.all(accountId)
					.map((row) => parseMachineAdvert(MachineRow.parse(row).body)),
			);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	put(advert: MachineAdvert): Promise<void> {
		return this.atomic(() => {
			const checked = defineMachineAdvert(create(MachineAdvertSchema, advert));
			const kept = this.read(checked.id);
			if (!kept) {
				this.write(checked);
				return;
			}
			if (kept.accountId !== checked.accountId)
				throw new MachineRegistryError(
					"other_account",
					`machine ${checked.id} belongs to another account`,
				);
			if (kept.signerKeyId !== checked.signerKeyId)
				throw new MachineRegistryError(
					"other_key",
					`machine ${checked.id} is pinned to another key`,
				);
			this.write(
				defineMachineAdvert(
					create(MachineAdvertSchema, {
						...checked,
						paused: kept.paused,
						sharing: kept.sharing,
					}),
				),
			);
		});
	}

	setPaused(id: string, paused: boolean, _by: string): Promise<void> {
		return this.atomic(() => {
			const machine = this.known(id);
			this.write(
				defineMachineAdvert(
					create(MachineAdvertSchema, { ...machine, paused }),
				),
			);
		});
	}

	setSharing(id: string, sharing: MachineSharing): Promise<void> {
		return this.atomic(() => {
			const machine = this.known(id);
			this.write(
				defineMachineAdvert(
					create(MachineAdvertSchema, { ...machine, sharing }),
				),
			);
		});
	}

	remove(id: string): Promise<void> {
		return this.atomic(() => {
			this.db.prepare("DELETE FROM ci_machines WHERE id = ?").run(id);
		});
	}
}
