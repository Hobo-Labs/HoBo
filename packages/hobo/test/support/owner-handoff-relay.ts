import {
	createOwnerHandoffMailbox,
	type OwnerHandoffEnvelopeWire,
	ownerHandoffSealing,
} from "@hobo/ci-vercel/owner-handoff";
import {
	type EphemeralEntry,
	type EphemeralStatePort,
	type EphemeralWrite,
	parseEphemeralVersion,
} from "@hobo/core";
import { expect } from "vitest";
import { z } from "zod";

export const OWNER_HANDOFF_RELAY = "https://relay.example";
const API = "/v1/owner-handoff/mailboxes";

function memoryState(clock: { now: number }): EphemeralStatePort {
	const entries = new Map<
		string,
		{ value: string; version: EphemeralEntry["version"]; until: number }
	>();
	let versions = 0;
	const live = (key: string) => {
		const entry = entries.get(key);
		if (entry === undefined || entry.until <= clock.now) {
			entries.delete(key);
			return undefined;
		}
		return entry;
	};
	const write = (key: string, value: string, ttl: number): EphemeralWrite => {
		versions += 1;
		const version = parseEphemeralVersion(`v${versions}`);
		entries.set(key, { value, version, until: clock.now + ttl });
		return { applied: true, version };
	};
	return {
		get: async (key) => live(key),
		getMany: async (keys) => keys.map((key) => live(key)),
		putIfAbsent: async (key, value, ttl) =>
			live(key) === undefined ? write(key, value, ttl) : { applied: false },
		compareAndSet: async (key, expected, value, ttl) =>
			live(key)?.version === expected
				? write(key, value, ttl)
				: { applied: false },
		delete: async (key, expected) => {
			const entry = live(key);
			if (entry === undefined) return false;
			if (expected !== undefined && entry.version !== expected) return false;
			return entries.delete(key);
		},
		increment: async (key, by, ttl) => {
			const next = Number(live(key)?.value ?? "0") + by;
			write(key, String(next), ttl);
			return next;
		},
		expire: async (key, ttl) => {
			const entry = live(key);
			if (entry === undefined) return false;
			entry.until = clock.now + ttl;
			return true;
		},
	};
}

const Offer = z
	.object({
		mailboxId: z.string(),
		recipientKey: z.string(),
		binding: z.string(),
		expiresAtMs: z.number(),
		keyProof: z.string(),
	})
	.strict();

export function ownerHandoffRelay(clock: { now: number }) {
	const mailbox = createOwnerHandoffMailbox({
		state: memoryState(clock),
		environment: "test",
		now: () => clock.now,
	});
	const sent: string[] = [];
	const fetchRelay: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		sent.push(
			`${request.method} ${request.url} ${await request.clone().text()}`,
		);
		return mailbox(request);
	};
	const offerFor = async (ticket: string) => {
		const sealing = ownerHandoffSealing();
		const mailboxId = await sealing.mailboxOf(ticket);
		const shown = await mailbox(
			new Request(`${OWNER_HANDOFF_RELAY}${API}/${mailboxId}`),
		);
		return shown.status === 200
			? { mailboxId, offer: Offer.parse(await shown.json()) }
			: { mailboxId, status: shown.status };
	};
	const deposit = async (
		mailboxId: string,
		envelope: OwnerHandoffEnvelopeWire,
	) =>
		(
			await mailbox(
				new Request(`${OWNER_HANDOFF_RELAY}${API}/${mailboxId}/envelope`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(envelope),
				}),
			)
		).status;
	const owner = async (
		url: string,
		answer: Readonly<Record<string, string>>,
	) => {
		const ticket = new URL(url).hash.slice(1);
		const sealing = ownerHandoffSealing();
		const found = await offerFor(ticket);
		if (found.offer === undefined) return found.status;
		expect(await sealing.verifyOffer(ticket, found.offer)).toBe(true);
		return deposit(
			found.mailboxId,
			await sealing.seal(ticket, found.offer, answer),
		);
	};
	return { fetchRelay, owner, offerFor, deposit, sent };
}
