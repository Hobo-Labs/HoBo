import { readFileSync } from "node:fs";
import { loadCiProjectFromDirectory } from "@hobo/ci-gh-actions/cli-serve";
import { ownerHandoffSealing } from "@hobo/ci-vercel/owner-handoff";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createOwnerLinkChannel,
	projectRelayOrigin,
} from "../src/owner-link.js";
import {
	ownerHandoffRelay,
	OWNER_HANDOFF_RELAY as RELAY,
} from "./support/owner-handoff-relay.js";

const CWD = "/synthetic/project";
const ANSWER = {
	store: "1password",
	OP_VAULT_ID: "abcdefghijklmnopqrstuvwxyz",
	ONEPASSWORD_EMAIL: "owner@synthetic.example",
	ONEPASSWORD_SECRET_KEY: "A3-SYNTHETIC-PRIVATE-SECRETKEY-00000",
	ONEPASSWORD_PASSWORD: "synthetic private password",
};

const relay = (clock: { now: number }) => {
	const made = ownerHandoffRelay(clock);
	return {
		...made,
		owner: (url: string, answer: Readonly<Record<string, string>> = ANSWER) =>
			made.owner(url, answer),
	};
};

function channel(clock: { now: number }, fetchRelay: typeof fetch) {
	return createOwnerLinkChannel({
		relayOrigin: async () => RELAY,
		fetch: fetchRelay,
		now: () => clock.now,
		sleep: async (ms) => {
			clock.now += ms;
		},
		pollMs: 1_000,
	});
}

describe("the owner's one-time link", () => {
	it("round-trips the owner's answer end to end through the relay, which holds only ciphertext", async () => {
		const clock = { now: 1_800_000_000_000 };
		const { fetchRelay, owner, sent } = relay(clock);
		const link = channel(clock, fetchRelay);
		const issued = await link.issue(CWD);
		expect(issued.kind).toBe("issued");
		if (issued.kind !== "issued") return;
		expect(issued.url).toMatch(
			/^https:\/\/relay\.example\/owner-handoff#[A-Za-z0-9_-]{43}$/u,
		);
		expect(link.pending(CWD)).toBe(true);
		expect(await link.collect(CWD, 3_000)).toMatchObject({
			kind: "waiting",
			url: issued.url,
		});
		expect(await owner(issued.url)).toBe(204);
		expect(await link.collect(CWD, 3_000)).toEqual({
			kind: "answered",
			answer: ANSWER,
		});
		expect(link.pending(CWD)).toBe(false);
		const wire = sent.join("\n");
		const ticket = new URL(issued.url).hash.slice(1);
		expect(wire).not.toContain(ticket);
		for (const value of Object.values(ANSWER).slice(1))
			expect(wire).not.toContain(value);
		expect(await owner(issued.url)).toBe(410);
	});

	it("refuses a replayed, expired or foreign answer", async () => {
		const clock = { now: 1_800_000_000_000 };
		const { fetchRelay, owner, offerFor, deposit } = relay(clock);
		const link = channel(clock, fetchRelay);
		const first = await link.issue(CWD);
		if (first.kind !== "issued") throw new Error("not issued");
		clock.now += 10 * 60_000;
		expect(await link.collect(CWD, 0)).toEqual({
			kind: "refused",
			reason: "expired",
		});
		expect(await owner(first.url)).toBe(404);

		const second = await link.issue(CWD);
		if (second.kind !== "issued") throw new Error("not issued");
		const other = createOwnerLinkChannel({
			relayOrigin: async () => RELAY,
			fetch: fetchRelay,
			now: () => clock.now,
		});
		const foreign = await other.issue(CWD);
		if (foreign.kind !== "issued") throw new Error("not issued");
		const ticket = new URL(second.url).hash.slice(1);
		const mine = await offerFor(ticket);
		const theirs = await offerFor(new URL(foreign.url).hash.slice(1));
		if (mine.offer === undefined || theirs.offer === undefined)
			throw new Error("no offer");
		const misbound = await ownerHandoffSealing().seal(
			ticket,
			{ ...mine.offer, binding: theirs.offer.binding },
			ANSWER,
		);
		expect(await deposit(mine.mailboxId, misbound)).toBe(204);
		expect(await link.collect(CWD, 0)).toEqual({
			kind: "refused",
			reason: "unreadable",
		});
		expect(await link.collect(CWD, 0)).toEqual({
			kind: "refused",
			reason: "expired",
		});
	});

	it("names the reason when no relay can carry the link", async () => {
		const clock = { now: 1_800_000_000_000 };
		const unconfigured = createOwnerLinkChannel({
			relayOrigin: async () => undefined,
		});
		expect(await unconfigured.issue(CWD)).toEqual({
			kind: "unavailable",
			reason: "owner-link-relay-unconfigured",
		});
		const unreachable = channel(clock, async () => {
			throw new TypeError("fetch failed");
		});
		expect(await unreachable.issue(CWD)).toEqual({
			kind: "unavailable",
			reason: "owner-link-relay-unreachable",
		});
		const notReady = channel(clock, async () =>
			Response.json(
				{ ready: false, state: "no-mailbox-store" },
				{ status: 503 },
			),
		);
		expect(await notReady.issue(CWD)).toEqual({
			kind: "unavailable",
			reason: "owner-link-relay-not-ready",
		});
	});

	it("finds the relay from HOBO_CI_RELAY_URL, else the project's committed CI config", async () => {
		expect(
			await projectRelayOrigin("/nowhere", {
				HOBO_CI_RELAY_URL: "https://relay.example/",
			}),
		).toBe("https://relay.example");
		const repoRoot = new URL("../../../", import.meta.url).pathname;
		const committed = await loadCiProjectFromDirectory({
			repositoryRoot: repoRoot,
		});
		expect(committed.environmentName).toBe("ci");
		expect(await projectRelayOrigin(`${repoRoot}packages/hobo`, {})).toBe(
			committed.environment.relayOrigin,
		);
		expect(
			await projectRelayOrigin(`${repoRoot}packages/hobo`, {
				HOBO_CI_ENVIRONMENT: "local",
			}),
		).toBeUndefined();
	});
});

const PactRequest = z.object({
	method: z.enum(["POST", "PUT"]),
	path: z.string(),
	headers: z.record(z.string(), z.string()),
	body: z.json().optional(),
});
const Pact = z.object({
	consumer: z.object({ name: z.literal("hobo-mcp-owner-link") }),
	metadata: z.object({ providerClockMs: z.number() }),
	interactions: z.array(
		z.object({
			description: z.string(),
			providerState: z.string(),
			request: PactRequest,
			response: z.object({ status: z.number(), body: z.json().optional() }),
		}),
	),
});

describe("CONTRACT owner-handoff-relay (consumer)", () => {
	const pact = Pact.parse(
		JSON.parse(
			readFileSync(
				new URL("../contracts/owner-handoff-relay.pact.json", import.meta.url),
				"utf8",
			),
		),
	);
	const recorded = (state: string, method: "POST" | "PUT", suffix: string) => {
		const found = pact.interactions.find(
			(interaction) =>
				interaction.providerState === state &&
				interaction.request.method === method &&
				interaction.request.path.endsWith(suffix),
		);
		if (found === undefined) throw new Error(`no interaction for ${state}`);
		return found;
	};
	const mailboxRoute = (path: string) =>
		path.replace(/\/[A-Za-z0-9_-]{43}(?=\/|$)/u, "/{mailbox}");
	const bodyFields = (body: z.infer<typeof PactRequest>["body"]) =>
		JSON.stringify(body, (_key, value) =>
			z.string().safeParse(value).success
				? `${z.string().parse(value).length}`
				: z.number().safeParse(value).success
					? 0
					: value,
		);

	it("sends the recorded requests and reads every recorded answer", async () => {
		const clock = { now: pact.metadata.providerClockMs };
		const register = recorded("no mailbox", "POST", "/mailboxes");
		let replay: (typeof pact.interactions)[number] = register;
		const sent: Request[] = [];
		const stub: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			sent.push(request);
			expect(request.method).toBe(replay.request.method);
			expect(mailboxRoute(new URL(request.url).pathname)).toBe(
				mailboxRoute(replay.request.path),
			);
			for (const name of Object.keys(replay.request.headers))
				expect(request.headers.has(name)).toBe(true);
			if (replay.request.body !== undefined)
				expect(bodyFields(z.json().parse(await request.json()))).toBe(
					bodyFields(replay.request.body),
				);
			return replay.response.body === undefined
				? new Response(null, { status: replay.response.status })
				: Response.json(replay.response.body, {
						status: replay.response.status,
					});
		};
		const link = channel(clock, stub);
		expect((await link.issue(CWD)).kind).toBe("issued");
		replay = recorded("an open mailbox", "POST", "/collect");
		expect((await link.collect(CWD, 0)).kind).toBe("waiting");
		replay = recorded("a sealed mailbox", "POST", "/collect");
		expect(await link.collect(CWD, 0)).toEqual({
			kind: "refused",
			reason: "unreadable",
		});
		for (const [state, outcome] of [
			["a collected mailbox", { kind: "refused", reason: "used" }],
			["an expired mailbox", { kind: "refused", reason: "expired" }],
		] satisfies [string, object][]) {
			replay = register;
			await link.issue(CWD);
			replay = recorded(state, "POST", "/collect");
			expect(await link.collect(CWD, 0)).toEqual(outcome);
		}
		replay = recorded("no mailbox store", "POST", "/mailboxes");
		expect(await link.issue(CWD)).toEqual({
			kind: "unavailable",
			reason: "owner-link-relay-not-ready",
		});
		expect(sent.length).toBe(8);
	});
});
