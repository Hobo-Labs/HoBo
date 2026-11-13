/**
 * The names of §6.7: streams, buckets, subjects and keys. Pure; every other
 * module of the bus builds its subjects here so that the permission templates
 * and the adapters cannot drift apart.
 */
import { createHash } from "node:crypto";
import type { FleetId, MemberId, WorkDigest } from "@hobo/fleet";

// public-contract: bucket and stream names of design §6.7, read by operators and the probe suite.
export const BUCKETS = {
	registry: "fleet-registry",
	views: "fleet-views",
	observations: "fleet-observations",
	replay: "fleet-replay",
} as const;

// public-contract: stream names of design §6.7.
export const STREAMS = {
	submissions: "FLEET_SUBMISSIONS",
	offers: "FLEET_OFFERS",
	claims: "FLEET_CLAIMS",
	orders: "FLEET_ORDERS",
	events: "FLEET_EVENTS",
	control: "FLEET_CONTROL",
	journal: "FLEET_JOURNAL",
	audit: "FLEET_AUDIT",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];
export type StreamName = (typeof STREAMS)[keyof typeof STREAMS];

/** The JetStream stream behind a key-value bucket. */
export function bucketStream(bucket: BucketName): string {
	return `KV_${bucket}`;
}

/** The subject a key-value entry is stored on. */
export function bucketSubject(bucket: BucketName, key: string): string {
	return `$KV.${bucket}.${key}`;
}

// public-contract: audit subjects of design §6.7.
export const AUDIT_SUBJECTS = {
	entry: "fleet.audit.entry",
	checkpoint: "fleet.audit.checkpoint",
	trust: "fleet.audit.trust",
	witness: "fleet.audit.witness",
} as const;

export const subjects = {
	submission: (fleet: FleetId) => `fleet.submission.${fleet}`,
	submissions: "fleet.submission.>",
	offer: (fleet: FleetId) => `fleet.offer.${fleet}`,
	offers: "fleet.offer.>",
	claim: (fleet: FleetId, digest: WorkDigest) =>
		`fleet.claim.${fleet}.${digest}`,
	claims: "fleet.claim.>",
	order: (to: MemberId) => `fleet.order.${to}`,
	orders: "fleet.order.>",
	event: (from: MemberId, kind: string) => `fleet.event.${from}.${kind}`,
	events: "fleet.event.>",
	control: (to: MemberId) => `fleet.control.${to}`,
	relay: (to: MemberId, session: string) => `fleet.relay.${to}.${session}`,
	relayOf: (self: MemberId) => `fleet.relay.${self}.>`,
} as const;

export const keys = {
	member: (id: MemberId) => `member.${id}`,
	fleet: (id: FleetId) => `fleet.${id}`,
	trust: "trust",
	observation: (observer: MemberId, member: MemberId) =>
		`${observer}.${member}`,
	/** Replay ids are arbitrary strings; the key holds a digest of each part so it is always a valid key. */
	replay: (scope: string, id: string) => `${digest(scope)}.${digest(id)}`,
} as const;

/** One subject token: what a stream or key part may hold without changing the subject's shape. */
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/u;

export function isToken(value: string): boolean {
	return TOKEN.test(value);
}

/** The tokens of a subject after a fixed prefix of `skip` tokens, or undefined when the shape differs. */
export function tokensAfter(
	subject: string,
	skip: number,
	count: number,
): readonly string[] | undefined {
	const parts = subject.split(".");
	if (parts.length !== skip + count) return undefined;
	return parts.slice(skip);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 40);
}
