// O18: backup and restore work. After a restore into a fresh deployment,
// every pre-backup member is ACTIVE, every pre-restore credential is refused
// with `incarnation-stale`, and the audit chain verifies.
import { join } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { MemberRecordSchema, MemberState } from "@hobo/fleet";
import { verifyAuditChain } from "@hobo/fleet/audit";
import { describe, expect, it } from "vitest";
import { backupArchive, restoreArchive } from "../../src/ops/archive.js";
import { checkIncarnation } from "../../src/ops/incarnation.js";
import { enrollmentAuthority, refresh } from "./members.js";
import {
	archiveDeps,
	freshDeployment,
	liveDeployment,
	waitFor,
} from "./restore-setup.js";

describe("O18 backup and restore", () => {
	it("restores every member ACTIVE, refuses every earlier credential, and keeps the audit chain", async () => {
		const live = await liveDeployment(3);
		const archive = join(live.fixture.dir, "fleet.backup");
		const backedUp = await backupArchive(
			archiveDeps(live.fixture, live.dep, live.dataDir, async () => live.store),
			archive,
		);
		if (!backedUp.ok) throw new Error(backedUp.error.message);
		expect(backedUp.value.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);
		await live.dep.stop();
		live.store.close();

		const restoredEntries = live.dep.audit.entries.length;
		const fresh = await freshDeployment(live);
		try {
			const restored = await restoreArchive(fresh.deps, archive);
			if (!restored.ok) throw new Error(restored.error.message);
			expect(restored.value.incarnation).toBe(2);
			const trust = fresh.dep.bus.registry.trust();
			expect(trust.authorityIncarnation).toBe(2);

			// Every pre-backup member is ACTIVE in the rebuilt registry, under the new incarnation.
			for (const member of live.members) {
				const record = await fresh.dep.bus.registry.member(member.memberId);
				expect(record?.state).toBe(MemberState.ACTIVE);
				expect(record?.authorityIncarnation).toBe(2);
			}

			// Every pre-restore credential is refused with incarnation-stale.
			for (const member of live.members) {
				for (const credential of [member.ticket, member.record]) {
					const checked = checkIncarnation(credential, trust);
					expect(checked.ok ? "ok" : checked.error.code).toBe(
						"incarnation-stale",
					);
				}
				expect(
					fromBinary(MemberRecordSchema, member.record.payload)
						.authorityIncarnation,
				).toBe(1);
			}

			// Every device refreshes: the restored journal still knows its generation.
			const store = await fresh.store();
			const authority = enrollmentAuthority(fresh.dep, store, live.now, 2);
			for (const member of live.members) {
				const again = await refresh(
					authority.authority,
					member.memberId,
					member.caller,
					member.generation,
				);
				if (!again.ok) throw new Error(again.error.message);
				const ticket = again.value.sessionTicket;
				if (ticket === undefined) throw new Error("no ticket");
				expect(checkIncarnation(ticket, trust).ok).toBe(true);
			}

			// The audit chain verifies: the restored entries, the checkpoints the
			// witness co-signed again, and a new checkpoint in the new incarnation.
			await fresh.dep.tickAudit();
			live.fixture.clock.advance(61_000);
			await fresh.dep.tickAudit();
			await fresh.dep.tickAudit();
			const before = fresh.dep.audit.witnessed.length;
			await waitFor(() => fresh.dep.audit.witnessed.length > before);
			const entries = await fresh.dep.audit.log.entries(1, 1_000_000);
			const verified = verifyAuditChain(
				entries,
				fresh.dep.audit.witnessed,
				fresh.dep.bus.registry.trust(),
			);
			if (!verified.ok) throw new Error(verified.error.message);
			// Final through the last entry but the one recording the last checkpoint itself.
			expect(verified.value.finalThrough).toBe(entries.length - 1);
			expect(verified.value.finalThrough).toBeGreaterThan(restoredEntries);
		} finally {
			await fresh.dep.stop();
			fresh.close();
		}
	}, 60_000);
});
