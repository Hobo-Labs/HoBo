// Backup and restore, the edges: a tampered archive, a deployment that is not
// fresh, another tenant, a witness that is down, a restore run twice, and the
// high-availability profile's journal copy.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTenantId } from "@hobo/core";
import { createMemoryEventStore } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import {
	backupArchive,
	readArchive,
	restoreArchive,
} from "../../src/ops/archive.js";
import { jsonlArchiver } from "../../src/ops/compose.js";
import { deployment } from "./harness.js";
import {
	archiveDeps,
	freshDeployment,
	liveDeployment,
} from "./restore-setup.js";

async function backedUp() {
	const live = await liveDeployment(2);
	const archive = join(live.fixture.dir, "fleet.backup");
	const result = await backupArchive(
		archiveDeps(live.fixture, live.dep, live.dataDir, async () => live.store),
		archive,
	);
	if (!result.ok) throw new Error(result.error.message);
	await live.dep.stop();
	return { live, archive, digest: result.value.manifestDigest };
}

describe("backup", () => {
	it("writes a manifest whose digest covers every part", async () => {
		const { live, archive, digest } = await backedUp();
		const read = await readArchive(archive);
		if (!read.ok) throw new Error(read.error.message);
		expect(read.value.digest).toBe(digest);
		expect(read.value.manifest.parts.map((part) => part.name).sort()).toEqual([
			"audit-checkpoints",
			"audit-entries",
			"journal",
			"trust",
		]);
		expect(read.value.manifest.incarnation).toBe(1);
		expect(read.value.manifest.journalFormat).toBe("sqlite");
		live.store.close();
	}, 30_000);

	it("refuses without a pinned trust record", async () => {
		const live = await liveDeployment(1);
		const empty = await deployment({
			secrets: live.fixture.secrets,
			prefix: live.fixture.prefix,
			store: live.store,
			now: live.now,
			genesis: false,
		});
		const result = await backupArchive(
			archiveDeps(live.fixture, empty, live.dataDir, async () => live.store),
			join(live.fixture.dir, "x.backup"),
		);
		expect(result.ok ? "" : result.error.code).toBe("unavailable");
		await empty.stop();
		await live.dep.stop();
		live.store.close();
	}, 30_000);

	it("copies the high-availability journal as every envelope in order, and says its restore is not offered", async () => {
		const store = createMemoryEventStore();
		await store.append(
			"fleet-member-a",
			[{ type: "fleet.MemberDeclared", data: {} }],
			{
				expectedSeq: 0,
				actor: { kind: "service", id: "test" },
				tenant: "acme",
			},
		);
		const archiver = jsonlArchiver(async () => store);
		const lines = new TextDecoder()
			.decode(await archiver.dump())
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.map((event) => event.streamId)).toEqual(["fleet-member-a"]);
		const loaded = await archiver.load(new Uint8Array(), "digest");
		expect(loaded.ok ? "" : loaded.error.code).toBe("unavailable");
	});
});

describe("restore", () => {
	it("refuses a tampered archive", async () => {
		const { live, archive } = await backedUp();
		const text = JSON.parse(await readFile(archive, "utf8"));
		const journal = Buffer.from(text.parts.journal, "base64");
		const last = journal.length - 1;
		journal.writeUInt8(journal.readUInt8(last) ^ 1, last);
		text.parts.journal = journal.toString("base64");
		await writeFile(archive, JSON.stringify(text));
		const fresh = await freshDeployment(live);
		const result = await restoreArchive(fresh.deps, archive);
		expect(result.ok ? {} : result.error.detail).toEqual({
			part: "journal",
			rule: "digest",
		});
		await fresh.dep.stop();
		live.store.close();
	}, 30_000);

	it("refuses a deployment that is not fresh", async () => {
		const { live, archive } = await backedUp();
		const into = {
			...archiveDeps(
				live.fixture,
				live.dep,
				live.dataDir,
				async () => live.store,
			),
		};
		const result = await restoreArchive(into, archive);
		expect(result.ok ? "" : result.error.code).toBe("conflict");
		live.store.close();
	}, 30_000);

	it("refuses an archive of another tenant", async () => {
		const { live, archive } = await backedUp();
		const fresh = await freshDeployment(live);
		const result = await restoreArchive(
			{ ...fresh.deps, tenant: parseTenantId("other") },
			archive,
		);
		expect(result.ok ? "" : result.error.code).toBe("invalid-request");
		await fresh.dep.stop();
		live.store.close();
	}, 30_000);

	it("waits for the witness, and a second run finishes without a second increment", async () => {
		const { live, archive } = await backedUp();
		live.store.close();
		const fresh = await freshDeployment(live);
		try {
			await fresh.dep.witness.stop();
			const down = await restoreArchive(
				{ ...fresh.deps, witnessTimeoutMs: 300 },
				archive,
			);
			expect(down.ok ? "" : down.error.code).toBe("unavailable");

			fresh.dep.witness.start();
			const first = await restoreArchive(fresh.deps, archive);
			if (!first.ok) throw new Error(first.error.message);
			expect(first.value.incarnation).toBe(2);
			const sequence = fresh.dep.bus.registry.trust().sequence;

			const second = await restoreArchive(fresh.deps, archive);
			if (!second.ok) throw new Error(second.error.message);
			expect(second.value.incarnation).toBe(2);
			expect(fresh.dep.bus.registry.trust().sequence).toBe(sequence);
		} finally {
			await fresh.dep.stop();
			fresh.close();
		}
	}, 30_000);
});
