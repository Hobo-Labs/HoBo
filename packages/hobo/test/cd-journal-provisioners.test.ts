import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it, vi } from "vitest";

import { neonJournalProvisioner } from "../src/cd-journal-provisioners.js";
import { secretStoreClaims } from "../src/secret-store-claims.js";

// Neon Claimable Postgres has no server-side idempotency: a second create is a
// second anonymous database, and its credential is lost. The provisioner
// creates only after an atomic claim in the owner's store.

function memoryStore(): OpenedSecretStore {
	return {
		id: "infisical",
		port: createMemorySecretsPort({ id: "memory" }),
		reference: (name) => `infisical://proj/prod/hobo-cd/${name}`,
	};
}

const created = {
	id: "01999999-0000-7000-8000-000000000001",
	status: "UNCLAIMED",
	neon_project_id: "fake-project-00000001",
	connection_string:
		"postgresql://neondb_owner:fixture@ep-fake-000001-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require",
	claim_url: "https://neon.new/claim/01999999-0000-7000-8000-000000000001",
	expires_at: "2026-08-11T12:00:00.000Z",
	created_at: "2026-08-08T12:00:00.000Z",
	updated_at: "2026-08-08T12:00:00.000Z",
};

const fixtureClaims = (store: OpenedSecretStore) =>
	secretStoreClaims(store, {
		prefix: "HOBO_CD_JOURNAL_CLAIM_",
		allowFixture: true,
	});

describe("the CD journal provisioner", () => {
	it("does not create an anonymous database without a durable atomic claim", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const provisioner = neonJournalProvisioner(fetch);
		// A fixture store, or a real one without an atomic create, holds no claim.
		const withoutCreateOnly: OpenedSecretStore = {
			...memoryStore(),
			port: { ...createMemorySecretsPort(), createOnly: undefined },
		};
		for (const store of [memoryStore(), withoutCreateOnly]) {
			const attempts = await Promise.allSettled([
				provisioner.create({
					member: "journal-1",
					idempotencyKey: "hobo-cd-journal:journal-1",
					store,
				}),
				provisioner.create({
					member: "journal-1",
					idempotencyKey: "hobo-cd-journal:journal-1",
					store,
				}),
			]);
			for (const result of attempts) {
				expect(result.status).toBe("rejected");
				if (result.status === "rejected")
					expect(String(result.reason)).toMatch(/durable.*atomic/i);
			}
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("creates once under a claim in the owner's store, and adopts on a re-run", async () => {
		const store = memoryStore();
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
			String(input).endsWith("/database")
				? Response.json(created, { status: 201 })
				: Response.json(created),
		);
		const provisioner = neonJournalProvisioner(fetch, fixtureClaims);
		const input = {
			member: "journal-1",
			idempotencyKey: "hobo-cd-journal:journal-1",
			store,
		};
		// Two machines at once: one claim, one database.
		const attempts = await Promise.allSettled([
			provisioner.create(input),
			provisioner.create(input),
		]);
		expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
		const posts = () =>
			fetch.mock.calls.filter(([, init]) => init?.method === "POST").length;
		expect(posts()).toBe(1);
		// The claim, with the database id, is in the store.
		const claim = await store.port.access(
			"HOBO_CD_JOURNAL_CLAIM_HOBO_CD_JOURNAL_JOURNAL_1_1_RESULT",
		);
		expect(
			claim.status === "ok" && JSON.parse(claim.material ?? "{}"),
		).toMatchObject({
			state: "created",
			databaseId: created.id,
		});
		// A later run adopts the database it made instead of creating another.
		const again = await provisioner.create(input);
		expect(again.connectionString).toBe(created.connection_string);
		expect(posts()).toBe(1);
	});

	it("tries again after a definite failure, under a new attempt", async () => {
		const store = memoryStore();
		let first = true;
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			if (first) {
				first = false;
				return new Response('{"message":"slow down"}', { status: 429 });
			}
			return Response.json(created, { status: 201 });
		});
		const provisioner = neonJournalProvisioner(fetch, fixtureClaims);
		const input = {
			member: "journal-2",
			idempotencyKey: "hobo-cd-journal:journal-2",
			store,
		};
		await expect(provisioner.create(input)).rejects.toThrow();
		await expect(provisioner.create(input)).resolves.toMatchObject({
			connectionString: created.connection_string,
		});
		const second = await store.port.access(
			"HOBO_CD_JOURNAL_CLAIM_HOBO_CD_JOURNAL_JOURNAL_2_2_RESULT",
		);
		expect(second.status).toBe("ok");
	});

	it("refuses colliding intent names instead of adopting another intent", async () => {
		const store = memoryStore();
		const first = fixtureClaims(store);
		const other = fixtureClaims(store);
		const claim = {
			key: "journal-a/b",
			state: "in-flight" as const,
			ref: "hobo-cd",
			attemptedAtMs: 1,
		};
		expect(await first.claim(claim)).toBe(true);
		await expect(other.get("journal-a-b")).rejects.toThrow(/not valid/);
		await expect(other.claim({ ...claim, key: "journal-a-b" })).rejects.toThrow(
			/not valid/,
		);
	});

	it("does not disclose malformed stored material in a parse error", async () => {
		const store = memoryStore();
		await store.port.put(
			"HOBO_CD_JOURNAL_CLAIM_JOURNAL_1_1",
			"sensitive-malformed-claim-material",
		);
		await expect(fixtureClaims(store).get("journal-1")).rejects.toThrow(
			/^The provisioning claim in infisical is not valid\.$/u,
		);
	});

	it("cannot let an old claimant finish or overwrite a later attempt", async () => {
		const store = memoryStore();
		const first = fixtureClaims(store);
		const second = fixtureClaims(store);
		const claim = {
			key: "journal-1",
			state: "in-flight" as const,
			ref: "hobo-cd",
			attemptedAtMs: 1,
		};
		expect(await first.claim(claim)).toBe(true);
		await first.put({ ...claim, state: "failed" });
		expect(await second.claim({ ...claim, attemptedAtMs: 2 })).toBe(true);
		await expect(
			first.put({ ...claim, state: "created", databaseId: "old-db" }),
		).rejects.toThrow(/No matching claim/);
		await expect(first.claim(claim)).rejects.toThrow(/cannot reuse/);
		expect(await second.get(claim.key)).toMatchObject({
			state: "in-flight",
			attemptedAtMs: 2,
		});
	});

	it("preserves and adopts a terminal record from the earlier format", async () => {
		const store = memoryStore();
		const legacy = {
			key: "journal-legacy",
			state: "created",
			ref: "hobo-cd",
			attemptedAtMs: 1,
			databaseId: "legacy-db",
		};
		await store.port.put(
			"HOBO_CD_JOURNAL_CLAIM_JOURNAL_LEGACY_1",
			JSON.stringify(legacy),
		);
		const claims = fixtureClaims(store);
		expect(await claims.get(legacy.key)).toEqual(legacy);
		expect(
			await claims.claim({
				key: legacy.key,
				state: "in-flight",
				ref: legacy.ref,
				attemptedAtMs: 2,
			}),
		).toBe(false);
	});
});
