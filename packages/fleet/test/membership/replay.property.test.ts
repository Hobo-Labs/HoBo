// Replay equals live state for every stream; two authority instances on one
// store, interleaved at random, never disagree; every registry-changing event
// carries the record's new sequence for its audit entry (§6.14, §7.5).
import { create } from "@bufbuild/protobuf";
import type { JsonObject } from "@hobo/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	ApprovalMode,
	DeclareRequestSchema,
	MemberKind,
	MemberRecordSchema,
	MemberState,
	TokenCreateRequestSchema,
} from "../../src/_generated/fleet_pb.js";
import type { EnrollmentAuthority, VerifiedToken } from "../../src/ports.js";
import {
	device,
	enrollment,
	type Harness,
	harness,
	refresh,
	type TestDevice,
	why,
} from "./fixtures.js";
import { decoded, value } from "./scenario.js";

function isJsonObject<T>(item: T): item is T & JsonObject {
	return Object.prototype.toString.call(item) === "[object Object]";
}

const OPS = [
	"invite",
	"enroll",
	"approve",
	"accept",
	"suspend",
	"resume",
	"revoke",
	"refresh",
	"declare",
	"reject",
] as const;

type Step = Readonly<{ op: number; target: number; replica: number }>;

/** Everything a reader can see, signing times stripped (they come from one clock anyway). */
async function snapshot(authority: EnrollmentAuthority, caller: VerifiedToken) {
	const members = value(await authority.listMembers({}, caller)).members.map(
		(envelope) =>
			create(MemberRecordSchema, {
				...decoded(envelope),
				issuedAt: "",
				notAfter: "",
			}),
	);
	const tokens = value(await authority.listTokens({}, caller)).tokens;
	return { members, tokens };
}

async function run(h: Harness, steps: readonly Step[], admin: VerifiedToken) {
	const replicas = [h.authority, h.another()];
	const tokens: string[] = [];
	const devices: TestDevice[] = [];
	let names = 0;
	// Two devices taken to ACTIVE first, on alternating replicas, so the random tail has live members to act on.
	const seed: Step[] = [0, 1, 3].flatMap((op) => [
		{ op, target: 0, replica: 0 },
	]);
	const prefix: Step[] = [
		...seed,
		...seed.map((step) => ({ ...step, target: 2, replica: 1 })),
	];
	for (const step of [...prefix, ...steps]) {
		const authority = replicas[step.replica] ?? h.authority;
		const op = OPS[step.op % OPS.length];
		const subject =
			devices.length === 0 ? undefined : devices[step.target % devices.length];
		const memberId = subject?.keys.memberId ?? "";
		switch (op) {
			case "invite": {
				names += 1;
				const issued = await authority.issueToken(
					create(TokenCreateRequestSchema, {
						fleet: "build",
						name: `d${names}`,
						ttlSeconds: 900,
					}),
					admin,
				);
				if (issued.ok) tokens.push(issued.value.token);
				break;
			}
			case "enroll": {
				// Mostly the newest token; sometimes an older, maybe used one.
				const token =
					step.target < 6
						? tokens.at(-1)
						: tokens[step.target % Math.max(tokens.length, 1)];
				if (token === undefined) break;
				const fresh = await device(h.clock.now());
				const enrolled = await authority.enroll(
					enrollment(fresh, {
						name: "",
						proof: { case: "bootstrapToken", value: token },
					}),
					undefined,
				);
				if (enrolled.ok) devices.push(fresh);
				break;
			}
			case "approve":
				await authority.approveKey({ memberId, request: why() }, admin);
				break;
			case "accept":
				if (step.target % 2 === 0)
					await authority.approveKey({ memberId, request: why() }, admin);
				await authority.accept({ memberId, request: why() }, admin);
				break;
			case "suspend":
				await authority.suspend({ memberId, request: why() }, admin);
				break;
			case "resume":
				await authority.resume({ memberId, request: why() }, admin);
				break;
			case "revoke":
				await authority.revoke({ memberId, request: why() }, admin);
				break;
			case "reject":
				await authority.reject({ memberId, request: why() }, admin);
				break;
			case "refresh":
				if (subject !== undefined)
					await authority.credentials(
						{ memberId, request: refresh(step.target % 3) },
						subject.caller,
					);
				break;
			case "declare":
				names += 1;
				await authority.declare(
					create(DeclareRequestSchema, {
						fleet: "build",
						kind:
							step.target % 2 === 0 ? MemberKind.BACKEND : MemberKind.TARGET,
						name: `s${names % 4}`,
					}),
					admin,
				);
				break;
			default:
				break;
		}
		h.clock.advance(1_000);
	}
	return replicas;
}

const steps = fc.array(
	fc.record({
		op: fc.nat({ max: OPS.length - 1 }),
		target: fc.nat({ max: 7 }),
		replica: fc.nat({ max: 1 }),
	}),
	{ minLength: 5, maxLength: 60 },
);

describe("replay and replicas", () => {
	it("two instances interleaved at random never disagree, and replay equals live state", async () => {
		const seen = { members: 0, active: 0 };
		await fc.assert(
			fc.asyncProperty(steps, async (plan) => {
				const h = await harness();
				await h.fleet("build", { approval: ApprovalMode.SINGLE });
				const admin = (await h.person({ kind: "user", id: "admin" })).caller;
				const [a, b] = await run(h, plan, admin);
				if (a === undefined || b === undefined) throw new Error("no replicas");
				const live = await snapshot(a, admin);
				seen.members += live.members.length;
				seen.active += live.members.filter(
					(m) => m.state === MemberState.ACTIVE,
				).length;
				expect(await snapshot(b, admin)).toEqual(live);
				// A fresh instance has nothing but the journal.
				expect(await snapshot(h.another(), admin)).toEqual(live);
			}),
			{ numRuns: 30, seed: 20_261_113 },
		);
		expect(seen.members).toBeGreaterThan(60);
		expect(seen.active).toBeGreaterThan(5);
	}, 120_000);

	it("every record-changing event carries subject and the record's new sequence", async () => {
		await fc.assert(
			fc.asyncProperty(steps, async (plan) => {
				const h = await harness();
				await h.fleet("build");
				const admin = (await h.person({ kind: "user", id: "admin" })).caller;
				await run(h, plan, admin);
				const last = new Map<string, number>();
				for await (const { event } of h.store.readAll()) {
					if (!event.streamId.startsWith("fleet-member-")) continue;
					const data = isJsonObject(event.data) ? event.data : {};
					const memberId = event.streamId.slice("fleet-member-".length);
					expect(data.subject).toBe(`member.${memberId}`);
					const record = data.record;
					if (record === undefined) {
						expect(data.subjectSequence).toBe(0);
						continue;
					}
					const sequence = (last.get(memberId) ?? 0) + 1;
					expect(data.subjectSequence).toBe(sequence);
					last.set(memberId, sequence);
				}
				// The live record's sequence is the last event's.
				const members = value(
					await h.authority.listMembers({}, admin),
				).members.map(decoded);
				for (const member of members)
					expect(member.recordSequence).toBe(last.get(member.memberId));
			}),
			{ numRuns: 20, seed: 20_261_113 },
		);
	}, 120_000);

	it("concurrent commands on two instances settle by compare-and-set", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const [a, b] = [h.authority, h.another()];
		const issued = value(
			await a.issueToken(
				create(TokenCreateRequestSchema, {
					fleet: "build",
					name: "race",
					ttlSeconds: 900,
				}),
				admin,
			),
		);
		const racers = await Promise.all([
			device(h.clock.now()),
			device(h.clock.now()),
		]);
		const results = await Promise.all(
			racers.map((racer, i) =>
				(i === 0 ? a : b).enroll(
					enrollment(racer, {
						name: "race",
						proof: { case: "bootstrapToken", value: issued.token },
					}),
					undefined,
				),
			),
		);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(
			results.map((result) => (result.ok ? "ok" : result.error.code)).sort(),
		).toEqual(["ok", "token-used"]);
		const winner = racers[results.findIndex((result) => result.ok)];
		const memberId = winner?.keys.memberId ?? "";
		await Promise.all([
			a.approveKey({ memberId, request: why() }, admin),
			b.approveKey({ memberId, request: why() }, admin),
		]);
		const accepted = await Promise.all([
			a.accept({ memberId, request: why() }, admin),
			b.accept({ memberId, request: why() }, admin),
		]);
		expect(accepted.every((result) => result.ok)).toBe(true);
		expect(await snapshot(a, admin)).toEqual(await snapshot(b, admin));
		const events: string[] = [];
		for await (const { event } of h.store.readAll())
			if (event.streamId === `fleet-member-${memberId}`)
				events.push(event.type);
		expect(events).toEqual([
			"fleet.EnrollmentRequested",
			"fleet.KeyApproved",
			"fleet.EnrollmentAccepted",
			"fleet.MemberActivated",
		]);
	});
});
