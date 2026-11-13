// O6: clone detection without false locks (§6.5, F7, F19).
//
// An agent keeps its generation and pending refresh nonce on disk: it writes
// a fresh nonce before sending, and stores the new generation only when the
// response arrives. Two agents running from one copied key directory diverge
// on their first refreshes and are locked on the second; an honest agent whose
// responses are lost and who retries with the same generation and nonce is
// never locked.
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemberState } from "../../src/_generated/fleet_pb.js";
import type { EnrollmentAuthority } from "../../src/ports.js";
import { harness, refresh, type TestDevice } from "./fixtures.js";
import { active, code, stateOf, value } from "./scenario.js";

/** What an agent keeps in its key directory between refreshes. */
type Disk = { generation: number; pending: Uint8Array | undefined };

function agent(subject: TestDevice, disk: Disk) {
	return {
		disk,
		/** One refresh; `lose` drops the response on the way back (the authority still answered). */
		async refresh(authority: EnrollmentAuthority, lose: boolean) {
			disk.pending ??= new Uint8Array(randomBytes(16));
			const answer = await authority.credentials(
				{
					memberId: subject.keys.memberId,
					request: refresh(disk.generation, disk.pending),
				},
				subject.caller,
			);
			if (answer.ok && !lose) {
				disk.generation = answer.value.generation;
				disk.pending = undefined;
			}
			return answer.ok ? "ok" : answer.error.code;
		},
	};
}

describe("O6 clone detection", () => {
	it("locks two agents on one key directory on the second divergent refresh", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const subject = await active(h, admin);
		const original = agent(subject, { generation: 0, pending: undefined });
		expect(await original.refresh(h.authority, false)).toBe("ok");
		expect(original.disk.generation).toBe(1);

		// The key directory is copied now; both copies refresh from here.
		const copy = agent(subject, { ...original.disk });
		expect(await original.refresh(h.authority, false)).toBe("ok");
		expect(await copy.refresh(h.authority, false)).toBe("generation-mismatch");
		expect((await stateOf(h, subject, admin)).state).toBe(MemberState.LOCKED);
		// Both are refused from then on.
		expect(await original.refresh(h.authority, false)).toBe("member-locked");
		expect(await copy.refresh(h.authority, false)).toBe("member-locked");
		expect(h.logged).toContain("hobo_fleet_member_locked");
	});

	it("locks whichever copy refreshes second, on any authority replica", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const subject = await active(h, admin);
		const copy = agent(subject, { generation: 0, pending: undefined });
		const original = agent(subject, { generation: 0, pending: undefined });
		expect(await copy.refresh(h.another(), false)).toBe("ok");
		expect(await original.refresh(h.authority, false)).toBe(
			"generation-mismatch",
		);
	});

	it("1,000 randomised lost-response retries: zero locks", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const subject = await active(h, admin);
		const replicas = [h.authority, h.another()];
		const honest = agent(subject, { generation: 0, pending: undefined });
		let retries = 0;
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						lost: fc.integer({ min: 0, max: 3 }),
						replica: fc.integer({ min: 0, max: 1 }),
					}),
					{ minLength: 1_000, maxLength: 1_000 },
				),
				async (rounds) => {
					for (const round of rounds) {
						const before = honest.disk.generation;
						for (let i = 0; i < round.lost; i += 1) {
							expect(
								await honest.refresh(
									replicas[(round.replica + i) % 2] ?? h.authority,
									true,
								),
							).toBe("ok");
							retries += 1;
						}
						expect(
							await honest.refresh(
								replicas[round.replica] ?? h.authority,
								false,
							),
						).toBe("ok");
						expect(honest.disk.generation).toBe(before + 1);
					}
				},
			),
			{ numRuns: 1 },
		);
		expect(retries).toBeGreaterThan(500);
		expect((await stateOf(h, subject, admin)).state).toBe(MemberState.ACTIVE);
		expect(h.logged).not.toContain("hobo_fleet_member_locked");
		expect(honest.disk.generation).toBe(1_000);
	}, 120_000);

	it("never journals a refresh nonce or a credential", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const subject = await active(h, admin);
		const nonce = new Uint8Array(randomBytes(16));
		const answer = value(
			await h.authority.credentials(
				{ memberId: subject.keys.memberId, request: refresh(0, nonce) },
				subject.caller,
			),
		);
		const journal: string[] = [];
		for await (const positioned of h.store.readAll())
			journal.push(JSON.stringify(positioned.event.data));
		const text = journal.join("\n");
		expect(text).not.toContain(Buffer.from(nonce).toString("base64"));
		expect(text).not.toContain(Buffer.from(nonce).toString("hex"));
		expect(text).not.toContain(answer.svid);
		expect(
			code(
				await h.authority.credentials(
					{
						memberId: subject.keys.memberId,
						request: refresh(0, new Uint8Array(4)),
					},
					subject.caller,
				),
			),
		).toBe("invalid-request");
	});
});
