import { familySettings, type OpenedSecretStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	type JournalMemberProvisioner,
	journalFleetRuntime,
	journalMemberClaimEntry,
	journalMemberUrlEntry,
	prepareJournalFleet,
} from "../src/index.js";

// `hobo cd up` provisions the CD journal's fleet into the owner's store:
// connection strings and claim links straight into it, the fleet's shape as
// a setting, resumable after an interruption, and nothing on a re-run.

function memoryStore(): OpenedSecretStore {
	return {
		id: "infisical",
		port: createMemorySecretsPort({ id: "memory" }),
		reference: (name) => `infisical://proj/prod/hobo-cd/${name}`,
	};
}

function fakeNeon(failOn?: string) {
	const created: string[] = [];
	const provisioner: JournalMemberProvisioner = {
		plan: "neon-claimable",
		async create({ member, idempotencyKey }) {
			if (member === failOn) throw new Error("neon.new is unreachable");
			created.push(member);
			return {
				connectionString: `postgresql://u:p@${member}.neon.example/db`,
				claimUrl: `https://neon.new/claim/${idempotencyKey}`,
			};
		},
	};
	return { provisioner, created };
}

describe("prepareJournalFleet", () => {
	it("creates the members the journal's policy asks for and a witness, into the store", async () => {
		const store = memoryStore();
		const neon = fakeNeon();
		const step = await prepareJournalFleet({
			store,
			provisioners: [neon.provisioner],
		});
		expect(step.outcome).toBe("created");
		// standard with two standbys: a writer, two standbys and the witness.
		expect(neon.created).toEqual([
			"journal-1",
			"journal-2",
			"journal-3",
			"journal-witness",
		]);
		for (const member of neon.created) {
			const url = await store.port.access(journalMemberUrlEntry(member));
			expect(url.status === "ok" && url.material).toMatch(/^postgresql:/u);
			const claim = await store.port.access(journalMemberClaimEntry(member));
			expect(claim.status).toBe("ok");
		}
		// The step says where things are, never what they are.
		expect(step.detail).not.toContain("postgresql://");
		expect(step.detail).not.toContain("neon.new/claim");
		expect(await familySettings(store, "cd").read()).toMatchObject({
			HOBO_CD_POSTGRES_FLEET:
				"journal-1:neon-claimable,journal-2:neon-claimable,journal-3:neon-claimable",
			HOBO_CD_POSTGRES_WITNESSES: "journal-witness:neon-claimable",
		});
	});

	it("creates nothing on a re-run, and resumes an interrupted run", async () => {
		const store = memoryStore();
		const broken = fakeNeon("journal-3");
		await expect(
			prepareJournalFleet({ store, provisioners: [broken.provisioner] }),
		).rejects.toThrow(/unreachable/u);
		expect(broken.created).toEqual(["journal-1", "journal-2"]);
		const resumed = fakeNeon();
		expect(
			(
				await prepareJournalFleet({
					store,
					provisioners: [resumed.provisioner],
				})
			).outcome,
		).toBe("created");
		expect(resumed.created).toEqual(["journal-3", "journal-witness"]);
		const again = fakeNeon();
		expect(
			(await prepareJournalFleet({ store, provisioners: [again.provisioner] }))
				.outcome,
		).toBe("unchanged");
		expect(again.created).toEqual([]);
	});

	it("creates nothing under --what-if", async () => {
		const store = memoryStore();
		const neon = fakeNeon();
		const step = await prepareJournalFleet({
			store,
			provisioners: [neon.provisioner],
			whatIf: true,
		});
		expect(step.outcome).toBe("would-create");
		expect(neon.created).toEqual([]);
	});

	it("hands the CD runtime the fleet's settings and a reader for its connection strings", async () => {
		const store = memoryStore();
		await prepareJournalFleet({
			store,
			provisioners: [fakeNeon().provisioner],
		});
		const runtime = await journalFleetRuntime(store);
		expect(runtime.env.HOBO_CD_POSTGRES_FLEET).toContain("journal-1");
		expect(
			await runtime.readSecret(journalMemberUrlEntry("journal-1")),
		).toMatch(/^postgresql:/u);
	});
});
