import { DatabaseSync } from "node:sqlite";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type MachineAdvert,
	MachineAdvertSchema,
} from "../src/_generated/relay_job_pb.js";
import { generateMeshIdentity } from "../src/mesh/trust.js";
import { answerRelayJob } from "../src/runner-order/answer.js";
import { NO_ROUTE_FACTS } from "../src/runner-order/decide.js";
import {
	MACHINE_ADVERT_TTL_MS,
	MachineRegistryError,
	machineAdvertSigningPayload,
	machineCandidates,
	machineOnline,
	receiveMachineAdvert,
	registryMachineCandidates,
	removeMachine,
	type SignedMachineAdvert,
	setMachinePaused,
	setMachineSharing,
	signMachineAdvert,
	verifyMachineAdvert,
} from "../src/runner-order/machine-registry.js";
import { SqliteMachineRegistry } from "../src/runner-order/machine-registry-sqlite.js";
import type {
	MachineRegistry,
	RouteFactsSource,
} from "../src/runner-order/ports.js";
import {
	InMemoryMachineRegistry,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	testMachineAdvert,
	testRelayJobMessage,
} from "../src/runner-order/testing.js";

const NOW = 1_763_337_600_000;
const ACCOUNT = {
	accountId: "acct-1",
	ownerId: "42",
	ownerLogin: "octocat",
	nowMs: NOW,
};
const studioKey = generateMeshIdentity().identity;
const thiefKey = generateMeshIdentity().identity;

function advert(
	init: Partial<Omit<MachineAdvert, "$typeName" | "$unknown">> = {},
): MachineAdvert {
	return testMachineAdvert({ lastSeenMs: NOW, ...init });
}

function signed(
	init: Partial<Omit<MachineAdvert, "$typeName" | "$unknown">> = {},
	key = studioKey,
): SignedMachineAdvert {
	return signMachineAdvert(advert(init), key);
}

describe("signed machine adverts", () => {
	it("verifies under the key it names and nothing else", () => {
		const sent = signed();
		expect(sent.advert.signerKeyId).toBe(studioKey.publicKey);
		expect(verifyMachineAdvert(sent)).toBe(true);
		const other = signMachineAdvert(advert(), thiefKey);
		expect(
			verifyMachineAdvert({ advert: sent.advert, signature: other.signature }),
		).toBe(false);
	});

	it("fails when any field changes after signing", () => {
		const sent = signed();
		for (const change of [
			{ slots: 8 },
			{ sharing: "anyone" },
			{ accountId: "acct-2" },
			{ lastSeenMs: NOW + 60_000 },
			{ labels: ["self-hosted", "Linux", "X64", "gpu"] },
			{ signerKeyId: thiefKey.publicKey },
		])
			expect(
				verifyMachineAdvert({
					advert: create(MachineAdvertSchema, { ...sent.advert, ...change }),
					signature: sent.signature,
				}),
			).toBe(false);
	});

	it("refuses a key id that is not a public key, and a malformed signature", () => {
		expect(
			verifyMachineAdvert({ advert: advert(), signature: signed().signature }),
		).toBe(false);
		expect(
			verifyMachineAdvert({ advert: signed().advert, signature: "nope" }),
		).toBe(false);
	});

	it("signs a fixed encoding led by its context", () => {
		expect(JSON.parse(machineAdvertSigningPayload(advert()))[0]).toBe(
			"hobo-ci-machine-advert/v1",
		);
	});
});

describe("receiveMachineAdvert", () => {
	it("keeps a new machine and says it connected", async () => {
		const registry = new InMemoryMachineRegistry();
		const verdict = await receiveMachineAdvert(registry, signed(), ACCOUNT);
		expect(verdict.kind).toBe("accepted");
		expect(verdict.events.map((event) => event.type)).toEqual([
			"machine.connected",
		]);
		expect((await registry.list("acct-1")).map((m) => m.id)).toEqual(["m-1"]);
	});

	it("takes a renewal quietly and keeps the owner's pause and sharing", async () => {
		const registry = new InMemoryMachineRegistry();
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		await setMachinePaused(registry, {
			...ACCOUNT,
			id: "m-1",
			paused: true,
			by: "octocat",
		});
		await setMachineSharing(registry, {
			...ACCOUNT,
			id: "m-1",
			sharing: "anyone",
			by: "octocat",
		});
		const renewal = await receiveMachineAdvert(
			registry,
			signed({ lastSeenMs: NOW + 30_000, busy: 1 }),
			{ ...ACCOUNT, nowMs: NOW + 30_000 },
		);
		expect(renewal.kind).toBe("accepted");
		expect(renewal.events).toEqual([]);
		const [kept] = await registry.list("acct-1");
		expect(kept?.paused).toBe(true);
		expect(kept?.sharing).toBe("anyone");
		expect(kept?.busy).toBe(1);
	});

	it("says connected again when a machine comes back from offline", async () => {
		const registry = new InMemoryMachineRegistry();
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		const later = NOW + MACHINE_ADVERT_TTL_MS + 1;
		const back = await receiveMachineAdvert(
			registry,
			signed({ lastSeenMs: later }),
			{ ...ACCOUNT, nowMs: later },
		);
		expect(back.events.map((event) => event.type)).toEqual([
			"machine.connected",
		]);
	});

	it("refuses what is malformed, unsigned, from another account or stale", async () => {
		const registry = new InMemoryMachineRegistry();
		const reasons = [];
		for (const [sent, context] of [
			[
				{
					advert: create(MachineAdvertSchema, { ...signed().advert, slots: 0 }),
					signature: signed().signature,
				},
				ACCOUNT,
			],
			[
				{ advert: signed().advert, signature: signed({ slots: 3 }).signature },
				ACCOUNT,
			],
			[signed(), { ...ACCOUNT, accountId: "acct-2" }],
			[signed({ lastSeenMs: NOW - MACHINE_ADVERT_TTL_MS - 1 }), ACCOUNT],
			[signed({ lastSeenMs: NOW + MACHINE_ADVERT_TTL_MS + 1 }), ACCOUNT],
		] as const) {
			const verdict = await receiveMachineAdvert(registry, sent, context);
			reasons.push(verdict.kind === "refused" ? verdict.reason : "accepted");
		}
		expect(reasons).toEqual([
			"malformed",
			"invalid_signature",
			"wrong_account",
			"stale",
			"stale",
		]);
		expect(await registry.list("acct-1")).toEqual([]);
	});

	it("refuses an advert that claims another owner than the user who sent it", async () => {
		const registry = new InMemoryMachineRegistry();
		const reasons = [];
		for (const [sent, context] of [
			[signed({ ownerId: "7" }), ACCOUNT],
			[signed({ ownerLogin: "hubot" }), ACCOUNT],
			[signed(), { ...ACCOUNT, ownerId: "7", ownerLogin: "hubot" }],
		] as const) {
			const verdict = await receiveMachineAdvert(registry, sent, context);
			reasons.push(verdict.kind === "refused" ? verdict.reason : "accepted");
		}
		expect(reasons).toEqual(["wrong_owner", "wrong_owner", "wrong_owner"]);
		expect(await registry.list("acct-1")).toEqual([]);
	});

	it("keeps the owner a machine connected with: another member's renewal is refused", async () => {
		const registry = new InMemoryMachineRegistry();
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		const hubot = { ...ACCOUNT, ownerId: "7", ownerLogin: "hubot" };
		const claimed = await receiveMachineAdvert(
			registry,
			signed({ ownerId: "7", ownerLogin: "hubot", lastSeenMs: NOW + 1_000 }),
			{ ...hubot, nowMs: NOW + 1_000 },
		);
		expect(claimed.kind === "refused" && claimed.reason).toBe("wrong_owner");
		expect((await registry.list("acct-1"))[0]?.ownerId).toBe("42");
		expect(
			await registryMachineCandidates(registry, {
				...ACCOUNT,
				readers: new Set(["7"]),
			}),
		).toMatchObject([{ ownerCanRead: false }]);
	});

	it("keeps an advert dated ahead of the clock at the clock, so it lapses on time", async () => {
		const registry = new InMemoryMachineRegistry();
		const ahead = await receiveMachineAdvert(
			registry,
			signed({ lastSeenMs: NOW + 60_000 }),
			ACCOUNT,
		);
		expect(ahead.kind === "accepted" && ahead.advert.lastSeenMs).toBe(NOW);
		expect((await registry.list("acct-1"))[0]?.lastSeenMs).toBe(NOW);
		const honest = await receiveMachineAdvert(
			registry,
			signed({ lastSeenMs: NOW + 10_000 }),
			{ ...ACCOUNT, nowMs: NOW + 10_000 },
		);
		expect(honest.kind).toBe("accepted");
	});

	it("refuses an advert older than the one kept (a replay)", async () => {
		const registry = new InMemoryMachineRegistry();
		const old = signed({ lastSeenMs: NOW - 10_000 });
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		const replay = await receiveMachineAdvert(registry, old, ACCOUNT);
		expect(replay.kind === "refused" && replay.reason).toBe("stale");
	});
});

describe("machine.taken_over (M08)", () => {
	it("refuses a new key for a known machine until the owner removes it", async () => {
		const registry = new InMemoryMachineRegistry();
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		const takeover = await receiveMachineAdvert(
			registry,
			signed({}, thiefKey),
			ACCOUNT,
		);
		expect(takeover.kind === "refused" && takeover.reason).toBe("taken_over");
		expect(takeover.events).toMatchObject([
			{
				type: "machine.taken_over",
				machineId: "m-1",
				signerKeyId: thiefKey.publicKey,
			},
		]);
		const [kept] = await registry.list("acct-1");
		expect(kept?.signerKeyId).toBe(studioKey.publicKey);
		const again = await receiveMachineAdvert(
			registry,
			signed({ lastSeenMs: NOW + 5_000 }, thiefKey),
			{ ...ACCOUNT, nowMs: NOW + 5_000 },
		);
		expect(again.kind).toBe("refused");

		await removeMachine(registry, { ...ACCOUNT, id: "m-1", by: "octocat" });
		const rekeyed = await receiveMachineAdvert(
			registry,
			signed({ lastSeenMs: NOW + 6_000 }, thiefKey),
			{ ...ACCOUNT, nowMs: NOW + 6_000 },
		);
		expect(rekeyed.kind).toBe("accepted");
		expect((await registry.list("acct-1"))[0]?.signerKeyId).toBe(
			thiefKey.publicKey,
		);
	});
});

/**
 * The in-memory fake as the port should behave: a machine id stays with the
 * account it connected under. (The wave-0 fake moves it; package 00 is asked
 * to make it refuse, and to assert this in `machineRegistryConformance`.)
 */
class AccountPinnedMemoryRegistry extends InMemoryMachineRegistry {
	private readonly owners = new Map<string, string>();

	override async put(machine: MachineAdvert): Promise<void> {
		const account = this.owners.get(machine.id);
		if (account !== undefined && account !== machine.accountId)
			throw new MachineRegistryError(
				"other_account",
				`machine ${machine.id} belongs to another account`,
			);
		this.owners.set(machine.id, machine.accountId);
		await super.put(machine);
	}

	override async remove(id: string): Promise<void> {
		this.owners.delete(id);
		await super.remove(id);
	}
}

describe("machine.taken_over across accounts (M08)", () => {
	const stores: ReadonlyArray<readonly [string, () => MachineRegistry]> = [
		[
			"in memory, ids pinned to an account",
			() => new AccountPinnedMemoryRegistry(),
		],
		["SQLite", () => new SqliteMachineRegistry(new DatabaseSync(":memory:"))],
	];
	for (const [name, make] of stores)
		it(`refuses another account's advert for a known id (${name})`, async () => {
			const registry = make();
			await receiveMachineAdvert(registry, signed(), ACCOUNT);
			const evil = {
				accountId: "acct-evil",
				ownerId: "666",
				ownerLogin: "mallory",
				nowMs: NOW,
			};
			const takeover = await receiveMachineAdvert(
				registry,
				signed(
					{ accountId: "acct-evil", ownerId: "666", ownerLogin: "mallory" },
					thiefKey,
				),
				evil,
			);
			expect(takeover.kind === "refused" && takeover.reason).toBe("taken_over");
			expect(takeover.events).toMatchObject([
				{
					type: "machine.taken_over",
					accountId: "acct-evil",
					machineId: "m-1",
					signerKeyId: thiefKey.publicKey,
				},
			]);
			expect((await registry.list("acct-1")).map((m) => m.signerKeyId)).toEqual(
				[studioKey.publicKey],
			);
			expect(await registry.list("acct-evil")).toEqual([]);
		});
});

describe("owner changes", () => {
	it("pause, resume, share and remove give one event each and repeat safely", async () => {
		const registry = new InMemoryMachineRegistry();
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		const base = { ...ACCOUNT, id: "m-1", by: "octocat" };
		const events = [];
		for (const change of [
			() => setMachinePaused(registry, { ...base, paused: true }),
			() => setMachinePaused(registry, { ...base, paused: true }),
			() => setMachinePaused(registry, { ...base, paused: false }),
			() => setMachineSharing(registry, { ...base, sharing: "anyone" }),
			() => setMachineSharing(registry, { ...base, sharing: "anyone" }),
			() => removeMachine(registry, base),
			() => removeMachine(registry, base),
		])
			events.push((await change()).event?.type);
		expect(events).toEqual([
			"machine.paused",
			undefined,
			"machine.resumed",
			"machine.sharing_changed",
			undefined,
			"machine.removed",
			undefined,
		]);
	});

	it("never touches another account's machine", async () => {
		const registry = new InMemoryMachineRegistry();
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		const other = { accountId: "acct-2", nowMs: NOW, id: "m-1", by: "mallory" };
		expect(
			(await setMachinePaused(registry, { ...other, paused: true })).machine,
		).toBeUndefined();
		expect((await removeMachine(registry, other)).machine).toBeUndefined();
		const [kept] = await registry.list("acct-1");
		expect(kept?.paused).toBe(false);
	});
});

describe("machineCandidates", () => {
	it("is online for 90 seconds after the last advert", () => {
		const kept = advert();
		expect(machineOnline(kept, NOW + MACHINE_ADVERT_TTL_MS)).toBe(true);
		expect(machineOnline(kept, NOW + MACHINE_ADVERT_TTL_MS + 1)).toBe(false);
	});

	it("takes whether the owner can read the repository as an argument", () => {
		const [readable] = machineCandidates([advert()], {
			nowMs: NOW,
			readers: new Set(["42"]),
		});
		const [unreadable] = machineCandidates([advert()], {
			nowMs: NOW,
			readers: new Set(),
		});
		expect(readable?.ownerCanRead).toBe(true);
		expect(unreadable?.ownerCanRead).toBe(false);
		expect(readable?.runsOn).toBe("hobo-machine-m-1");
	});
});

/** A relay that routes from what the registry holds, as relay mode composes it. */
function relay(
	registry: MachineRegistry,
	clock: { nowMs: number },
	readers: ReadonlySet<string> = new Set(["42"]),
) {
	const facts: RouteFactsSource = {
		facts: async (_request, nowMs) => ({
			...NO_ROUTE_FACTS,
			machines: await registryMachineCandidates(registry, {
				accountId: "acct-1",
				nowMs,
				readers,
			}),
		}),
	};
	return async (
		init: Readonly<{
			actorId?: string;
			triggeringActorId?: string;
			inputs?: readonly (readonly [string, string])[];
		}> = {},
	) => {
		const answer = await answerRelayJob(
			testRelayJobMessage({
				inputs: [
					["machine", "self-hosted"],
					["github", "ubuntu-24.04"],
				],
				...init,
			}),
			{
				order: new InMemoryRunnerOrderSource(
					new Map([
						["octo/app", '{"steps":[{"key":"machine"},{"key":"github"}]}'],
					]),
				),
				facts,
				journal: new InMemoryRouteJournal(),
				nowMs: clock.nowMs,
				mode: "relay",
				node: "relay-1",
				accountId: "acct-1",
				checks: undefined,
			},
		);
		return new Map(answer.outputs.map((entry) => [entry.name, entry.value]));
	};
}

describe("parity cases against the fakes", () => {
	it("M04: a machine takes jobs up to its slots, then the job waits for it", async () => {
		const registry = new InMemoryMachineRegistry();
		const clock = { nowMs: NOW };
		const route = relay(registry, clock);
		await receiveMachineAdvert(
			registry,
			signed({ slots: 2, busy: 1 }),
			ACCOUNT,
		);
		const free = await route();
		expect(free.get("runner")).toBe("hobo-machine-m-1");
		expect(free.get("outcome")).toBe("routed");
		clock.nowMs = NOW + 1_000;
		await receiveMachineAdvert(
			registry,
			signed({ slots: 2, busy: 2, lastSeenMs: NOW + 1_000 }),
			{ ...ACCOUNT, nowMs: NOW + 1_000 },
		);
		const full = await route({ inputs: [["machine", "self-hosted"]] });
		expect(full.get("outcome")).toBe("waiting");
		expect(full.get("runner")).toBe("hobo-machine-m-1");
	});

	it("M05: a paused machine takes no new job, and resumes", async () => {
		const registry = new InMemoryMachineRegistry();
		const route = relay(registry, { nowMs: NOW });
		await receiveMachineAdvert(
			registry,
			signed({ busy: 1, slots: 2 }),
			ACCOUNT,
		);
		await setMachinePaused(registry, {
			...ACCOUNT,
			id: "m-1",
			paused: true,
			by: "octocat",
		});
		const paused = await route();
		expect(paused.get("runner")).toBe("ubuntu-24.04");
		expect((await registry.list("acct-1"))[0]?.busy).toBe(1);
		await setMachinePaused(registry, {
			...ACCOUNT,
			id: "m-1",
			paused: false,
			by: "octocat",
		});
		expect((await route()).get("runner")).toBe("hobo-machine-m-1");
	});

	it("M06: only_me serves its owner; anyone also needs the owner to read the repository", async () => {
		const registry = new InMemoryMachineRegistry();
		const clock = { nowMs: NOW };
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		const teammate = { actorId: "7", triggeringActorId: "7" };
		expect((await relay(registry, clock)()).get("runner")).toBe(
			"hobo-machine-m-1",
		);
		expect((await relay(registry, clock)(teammate)).get("runner")).toBe(
			"ubuntu-24.04",
		);
		await setMachineSharing(registry, {
			...ACCOUNT,
			id: "m-1",
			sharing: "anyone",
			by: "octocat",
		});
		expect((await relay(registry, clock)(teammate)).get("runner")).toBe(
			"hobo-machine-m-1",
		);
		expect(
			(await relay(registry, clock, new Set())(teammate)).get("runner"),
		).toBe("ubuntu-24.04");
	});

	it("M09: a removed machine is left out of the next decision", async () => {
		const registry = new InMemoryMachineRegistry();
		const route = relay(registry, { nowMs: NOW });
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		expect((await route()).get("runner")).toBe("hobo-machine-m-1");
		await removeMachine(registry, { ...ACCOUNT, id: "m-1", by: "octocat" });
		expect((await route()).get("runner")).toBe("ubuntu-24.04");
	});

	it("a machine whose advert lapsed is passed over", async () => {
		const registry = new InMemoryMachineRegistry();
		const clock = { nowMs: NOW };
		const route = relay(registry, clock);
		await receiveMachineAdvert(registry, signed(), ACCOUNT);
		clock.nowMs = NOW + MACHINE_ADVERT_TTL_MS + 1;
		expect((await route()).get("runner")).toBe("ubuntu-24.04");
	});
});
