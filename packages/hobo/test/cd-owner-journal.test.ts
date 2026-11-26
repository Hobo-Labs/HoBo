import { tmpdir } from "node:os";

import {
	type JournalMemberProvisioner,
	journalMemberUrlEntry,
	prepareJournalFleet,
} from "@hobo/hobo-cd";
import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import { withOwnerJournalFleet } from "../src/cd-owner-journal.js";

// The CD runtime a verb opens finds the journal fleet hobo cd up provisioned:
// its shape from the owner's stored settings, connection strings read from
// the store only when the journal opens.

function memoryStore(): OpenedSecretStore {
	return {
		id: "infisical",
		port: createMemorySecretsPort({ id: "memory" }),
		reference: (name) => `infisical://proj/prod/hobo-cd/${name}`,
	};
}

const neon: JournalMemberProvisioner = {
	plan: "neon-claimable",
	async create({ member }) {
		return { connectionString: `postgresql://u:p@${member}.example/db` };
	},
};

describe("withOwnerJournalFleet", () => {
	it("selects the stored fleet and reads its connection strings from the store", async () => {
		const store = memoryStore();
		await prepareJournalFleet({ store, provisioners: [neon] });
		const journal = await withOwnerJournalFleet(
			{},
			tmpdir(),
			async () => store,
		);
		expect(journal.env.HOBO_CD_POSTGRES_FLEET).toContain(
			"journal-1:neon-claimable",
		);
		expect(journal.env.HOBO_CD_POSTGRES_WITNESSES).toBe(
			"journal-witness:neon-claimable",
		);
		// No connection string is put in the environment.
		expect(JSON.stringify(journal.env)).not.toContain("postgresql://");
		expect(
			await journal.readSecret?.(journalMemberUrlEntry("journal-2")),
		).toMatch(/^postgresql:/u);
	});

	it("leaves a journal the environment selects, and a project without a store, as they are", async () => {
		let opened = 0;
		const open = async () => {
			opened += 1;
			return memoryStore();
		};
		const env = { HOBO_CD_POSTGRES_FLEET: "mine" };
		expect(await withOwnerJournalFleet(env, tmpdir(), open)).toEqual({ env });
		expect(opened).toBe(0);
		// No committed locator in the directory: the store is not opened.
		expect(await withOwnerJournalFleet({}, tmpdir())).toEqual({ env: {} });
	});

	it("uses an explicitly selected SQLite journal without opening the owner store", async () => {
		const env = { HOBO_CD_SQLITE_PATH: "/tmp/local-journal.sqlite" };
		let opened = false;
		const open = async () => {
			opened = true;
			throw new Error("offline");
		};
		expect(await withOwnerJournalFleet(env, tmpdir(), open)).toEqual({ env });
		expect(opened).toBe(false);
	});

	it("does not treat a blank SQLite path as an explicit journal", async () => {
		const env = { HOBO_CD_SQLITE_PATH: "  " };
		let opened = false;
		const open = async () => {
			opened = true;
			throw new Error("offline");
		};
		await expect(withOwnerJournalFleet(env, tmpdir(), open)).rejects.toThrow(
			/cannot open the owner's secret store/i,
		);
		expect(opened).toBe(true);
	});

	it("refuses a configured store that cannot be opened instead of starting a different journal", async () => {
		for (const open of [
			async () => undefined,
			async () => {
				throw new Error("private sign-in detail");
			},
		]) {
			await expect(withOwnerJournalFleet({}, tmpdir(), open)).rejects.toThrow(
				/cannot open the owner's secret store/i,
			);
		}
	});
});
