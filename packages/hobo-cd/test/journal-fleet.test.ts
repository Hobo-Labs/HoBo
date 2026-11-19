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

function serialStore(base: OpenedSecretStore): OpenedSecretStore {
	let pending: Promise<void> = Promise.resolve();
	return {
		...base,
		withWriteLock: <T>(operation: () => Promise<T>): Promise<T> => {
			const result = pending.then(operation);
			pending = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
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
	it("keeps the store selection fixed while creating and recording the fleet", async () => {
		const base = memoryStore();
		let locked = false;
		const store: OpenedSecretStore = {
			...base,
			withWriteLock: async (operation) => {
				locked = true;
				try {
					return await operation();
				} finally {
					locked = false;
				}
			},
			port: {
				...base.port,
				put: async (name, value) => {
					expect(locked).toBe(true);
					return base.port.put(name, value);
				},
			},
		};
		const neon = fakeNeon();
		const provisioner: JournalMemberProvisioner = {
			...neon.provisioner,
			create: async (input) => {
				expect(locked).toBe(true);
				return neon.provisioner.create(input);
			},
		};
		await prepareJournalFleet({ store, provisioners: [provisioner] });
		expect(locked).toBe(false);
	});
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
		expect(step.detail).not.toContain("infisical://proj/");
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

	it("reads the fleet after acquiring the shared write lock", async () => {
		const store = serialStore(memoryStore());
		const neon = fakeNeon();
		const steps = await Promise.all([
			prepareJournalFleet({ store, provisioners: [neon.provisioner] }),
			prepareJournalFleet({ store, provisioners: [neon.provisioner] }),
		]);
		expect(steps.map((step) => step.outcome)).toEqual(["created", "unchanged"]);
		expect(neon.created).toEqual([
			"journal-1",
			"journal-2",
			"journal-3",
			"journal-witness",
		]);
	});

	it("resumes a failed setup after taking the shared write lock", async () => {
		const store = serialStore(memoryStore());
		const neon = fakeNeon();
		let fail = true;
		const provisioner: JournalMemberProvisioner = {
			...neon.provisioner,
			create: async (input) => {
				if (input.member === "journal-2" && fail) {
					fail = false;
					throw new Error("provisioning interrupted");
				}
				return neon.provisioner.create(input);
			},
		};
		const results = await Promise.allSettled([
			prepareJournalFleet({ store, provisioners: [provisioner] }),
			prepareJournalFleet({ store, provisioners: [provisioner] }),
		]);
		expect(results[0]?.status).toBe("rejected");
		expect(results[1]?.status).toBe("fulfilled");
		expect(neon.created).toEqual([
			"journal-1",
			"journal-2",
			"journal-3",
			"journal-witness",
		]);
	});

	it.each([
		{ fleet: "", witnesses: "" },
		{ fleet: "journal-1:neon-claimable", witnesses: undefined },
		{ fleet: undefined, witnesses: "journal-witness:neon-claimable" },
		{
			fleet: "journal-1:neon-claimable:extra",
			witnesses: "journal-witness:neon-claimable",
		},
		{
			fleet: "Journal-1:neon-claimable",
			witnesses: "journal-witness:neon-claimable",
		},
		{
			fleet: "journal-1:constructor",
			witnesses: "journal-witness:neon-claimable",
		},
		{
			fleet: "journal-1:neon-claimable,journal-1:neon-claimable",
			witnesses: "journal-witness:neon-claimable",
		},
		{
			fleet: "journal-1:neon-claimable",
			witnesses: "journal-1:neon-claimable",
		},
	])("refuses an incomplete or invalid saved fleet", async (fixture) => {
		const store = memoryStore();
		const settings: Record<string, string> = {};
		if (fixture.fleet !== undefined)
			settings.HOBO_CD_POSTGRES_FLEET = fixture.fleet;
		if (fixture.witnesses !== undefined)
			settings.HOBO_CD_POSTGRES_WITNESSES = fixture.witnesses;
		await familySettings(store, "cd").write(settings);
		const neon = fakeNeon();
		for (const whatIf of [true, false])
			await expect(
				prepareJournalFleet({
					store,
					provisioners: [neon.provisioner],
					whatIf,
				}),
			).rejects.toThrow(/invalid|incomplete/u);
		await expect(journalFleetRuntime(store)).rejects.toThrow(
			/invalid|incomplete/u,
		);
		expect(neon.created).toEqual([]);
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
