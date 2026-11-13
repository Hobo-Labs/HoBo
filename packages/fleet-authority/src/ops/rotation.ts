// Key rotation (design §6.16): add, publish, switch, remove, in that order,
// safe to interrupt at any step. Progress is kept in its own secret
// (`<prefix>/rotation/<which>`, no key material) and every step is idempotent,
// so a second call continues from the step the first reached. Private to L27.
import { generateKeyPairSync } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import type { JsonObject } from "@hobo/core";
import {
	type Clock,
	type FleetLog,
	KeyPurpose,
	type Outcome,
	type PublicKeyRef,
	TrustRecordSchema,
} from "@hobo/fleet";
import type { SecretsPort } from "@hobo/identity";
import type { RotatableKey } from "./index.js";
import {
	isJsonArray,
	isJsonObject,
	numberField,
	parseJson,
	stringField,
} from "./json.js";
import {
	activeKey,
	freshKey,
	KEY_KINDS,
	type KeySlot,
	keyRefOf,
	nextKid,
	readSecret,
	readSlot,
	rotationName,
	signerOf,
	slotName,
	writeSlot,
} from "./slots.js";
import { changeTrust, nextTrustRecord, type TrustDeps } from "./trust.js";

export type RotationStep = "add" | "publish" | "switch" | "remove";
export type Reached = RotationStep | "done";

/**
 * How long after the switch the old key stays published: the longest a
 * credential or registry record it signed stays valid (records 30 minutes,
 * tickets and tokens 15).
 */
export const ROTATION_GRACE_MS = 30 * 60 * 1_000;
/** The token ring's own rule (@hobo/identity): a retired key verifies for 15 minutes. */
export const TOKEN_GRACE_MS = 15 * 60 * 1_000;

export type NatsKey = Exclude<
	RotatableKey,
	"token-signing" | "record-signing" | "witness"
>;

/** Publishes the signing keys NATS accepts: the operator JWT's for `operator-signing`, the tenant account JWT's for the others. */
export type NatsSigningKeys = Readonly<{
	publish(
		which: NatsKey,
		publicKeys: readonly string[],
	): Promise<Outcome<void>>;
}>;

export type RotationDeps = Readonly<{
	secrets: SecretsPort;
	prefix: string;
	trust: TrustDeps;
	nats: NatsSigningKeys;
	graceMs?: number;
	now: Clock;
	log: FleetLog;
}>;

// domain-view: rotation progress as kept in its secret; holds key ids, never key material.
type Progress = Readonly<{
	reached: Reached;
	newKid: string;
	oldKid: string;
	switchedAtMs?: number;
	/** The proposed trust record of the current step, base64, so a resumed step proposes the same bytes. */
	proposal?: string;
}>;

/** A `Progress` while it is parsed. */
type ProgressDraft = { -readonly [K in keyof Progress]: Progress[K] };

const DONE: Progress = { reached: "done", newKid: "", oldKid: "" };

function parseProgress(text: string | undefined): Progress {
	const value = text === undefined ? undefined : parseJson(text);
	if (!isJsonObject(value)) return DONE;
	const reached = stringField(value, "reached");
	const newKid = stringField(value, "newKid") ?? "";
	const oldKid = stringField(value, "oldKid") ?? "";
	if (
		reached !== "add" &&
		reached !== "publish" &&
		reached !== "switch" &&
		reached !== "remove"
	)
		return DONE;
	const progress: ProgressDraft = { reached, newKid, oldKid };
	const switchedAtMs = numberField(value, "switchedAtMs");
	if (switchedAtMs !== undefined) progress.switchedAtMs = switchedAtMs;
	const proposal = stringField(value, "proposal");
	if (proposal !== undefined) progress.proposal = proposal;
	return progress;
}

async function readProgress(
	deps: RotationDeps,
	which: RotatableKey,
): Promise<Outcome<Progress>> {
	const text = await readSecret(deps.secrets, rotationName(deps.prefix, which));
	return text.ok ? { ok: true, value: parseProgress(text.value) } : text;
}

async function writeProgress(
	deps: RotationDeps,
	which: RotatableKey,
	progress: Progress,
): Promise<void> {
	await deps.secrets.put(
		rotationName(deps.prefix, which),
		JSON.stringify({ v: 1, ...progress }),
	);
}

function failure<T>(
	code: "invalid-request" | "unavailable",
	message: string,
): Outcome<T> {
	return { ok: false, error: { code, message } };
}

// ── The token ring (@hobo/identity's layout) ───────────────────────────────

// domain-view: one entry of @hobo/identity's token-signing ring secret.
type RingEntry = Readonly<{
	kid: string;
	privateKey: string;
	retiredAt?: number;
}>;

async function readRing(
	deps: RotationDeps,
): Promise<Outcome<readonly RingEntry[] | undefined>> {
	const name = slotName(deps.prefix, "token-signing");
	const text = await readSecret(deps.secrets, name);
	if (!text.ok) return text;
	if (text.value === undefined) return { ok: true, value: undefined };
	const value = parseJson(text.value);
	const list = isJsonObject(value) ? value.keys : undefined;
	if (!isJsonArray(list))
		return failure("invalid-request", `the secret ${name} is not a key ring`);
	const entries: RingEntry[] = [];
	for (const item of list) {
		const kid = isJsonObject(item) ? stringField(item, "kid") : undefined;
		const privateKey = isJsonObject(item)
			? stringField(item, "privateKey")
			: undefined;
		if (!isJsonObject(item) || kid === undefined || privateKey === undefined)
			return failure("invalid-request", `the secret ${name} is not a key ring`);
		const retiredAt = numberField(item, "retiredAt");
		entries.push(
			retiredAt === undefined
				? { kid, privateKey }
				: { kid, privateKey, retiredAt },
		);
	}
	return { ok: true, value: entries };
}

async function writeRing(
	deps: RotationDeps,
	entries: readonly RingEntry[],
): Promise<void> {
	const keys: JsonObject[] = entries.map((entry) =>
		entry.retiredAt === undefined
			? { kid: entry.kid, privateKey: entry.privateKey }
			: {
					kid: entry.kid,
					privateKey: entry.privateKey,
					retiredAt: entry.retiredAt,
				},
	);
	await deps.secrets.put(
		slotName(deps.prefix, "token-signing"),
		JSON.stringify({ keys }),
	);
}

function ringNumber(kid: string): number {
	const n = Number(kid.slice(kid.lastIndexOf("#") + 1));
	return Number.isSafeInteger(n) ? n : 0;
}

/** The ring's signing key under the rotation order: the oldest key not retired. */
export function activeRingKid(
	entries: readonly RingEntry[],
): string | undefined {
	return [...entries]
		.filter((entry) => entry.retiredAt === undefined)
		.sort((a, b) => ringNumber(a.kid) - ringNumber(b.kid))[0]?.kid;
}

async function rotateRing(
	deps: RotationDeps,
	progress: Progress,
): Promise<Outcome<Reached>> {
	const which = "token-signing";
	const ring = await readRing(deps);
	if (!ring.ok) return ring;
	if (ring.value === undefined)
		return failure(
			"invalid-request",
			"the token-signing key ring does not exist; run the ceremony first",
		);
	let entries = ring.value;
	let state = progress;
	if (state.reached === "done") {
		const oldKid = activeRingKid(entries) ?? "";
		const highest = Math.max(
			0,
			...entries.map((entry) => ringNumber(entry.kid)),
		);
		state = {
			reached: "add",
			oldKid,
			newKid: `${slotName(deps.prefix, which)}#${highest + 1}`,
		};
		await writeProgress(deps, which, state);
	}
	if (state.reached === "add") {
		// Publish: the new key joins the ring, so JWKS serves it; the old key still signs.
		if (!entries.some((entry) => entry.kid === state.newKid)) {
			const { privateKey } = generateKeyPairSync("rsa", {
				modulusLength: 2048,
			});
			entries = [
				...entries,
				{
					kid: state.newKid,
					privateKey: privateKey
						.export({ format: "pem", type: "pkcs8" })
						.toString(),
				},
			];
			await writeRing(deps, entries);
		}
		state = { ...state, reached: "publish" };
		await writeProgress(deps, which, state);
	}
	if (state.reached === "publish") {
		// Switch: the old key retires; it verifies for 15 minutes more and signs no longer.
		const at = deps.now();
		entries = entries.map((entry) =>
			entry.kid === state.oldKid && entry.retiredAt === undefined
				? { ...entry, retiredAt: at }
				: entry,
		);
		await writeRing(deps, entries);
		state = { ...state, reached: "switch", switchedAtMs: at };
		await writeProgress(deps, which, state);
	}
	if (state.reached === "switch") {
		if (deps.now() < (state.switchedAtMs ?? 0) + TOKEN_GRACE_MS)
			return { ok: true, value: "switch" };
		entries = entries.filter((entry) => entry.kid !== state.oldKid);
		await writeRing(deps, entries);
		state = { ...state, reached: "remove" };
		await writeProgress(deps, which, state);
	}
	await writeProgress(deps, which, DONE);
	return { ok: true, value: "done" };
}

// ── Slot keys: trust-record keys and NATS keys ─────────────────────────────

function refsOf(slot: KeySlot, purpose: KeyPurpose): PublicKeyRef[] {
	return slot.keys.map((key) => keyRefOf(key, purpose));
}

function sameKeys(
	a: readonly PublicKeyRef[],
	b: readonly PublicKeyRef[],
): boolean {
	const ids = (refs: readonly PublicKeyRef[]) =>
		refs
			.map((ref) => `${ref.keyId}=${ref.value}`)
			.sort()
			.join(",");
	return ids(a) === ids(b);
}

/** Makes the verifiers' key set for `which` equal the slot's keys. */
async function publishSlot(
	deps: RotationDeps,
	which: RotatableKey,
	slot: KeySlot,
	progress: Progress,
	step: RotationStep,
): Promise<Outcome<Progress>> {
	if (which === "record-signing" || which === "witness") {
		const pinned = deps.trust.bus.registry.trust();
		const purpose =
			which === "record-signing" ? KeyPurpose.AUTHORITY : KeyPurpose.WITNESS;
		const wanted = refsOf(slot, purpose);
		const current =
			which === "record-signing" ? pinned.authorityKeys : pinned.witnessKeys;
		if (sameKeys(current, wanted)) return { ok: true, value: progress };

		const signing = await readSlot(deps.secrets, deps.prefix, "record-signing");
		if (!signing.ok) return signing;
		if (signing.value === undefined)
			return failure(
				"invalid-request",
				"the record-signing key does not exist",
			);
		// A resumed step proposes the bytes it journalled before, if they are still the next record.
		const saved =
			progress.proposal === undefined
				? undefined
				: new Uint8Array(Buffer.from(progress.proposal, "base64"));
		const payload =
			saved !== undefined &&
			fromBinary(TrustRecordSchema, saved).sequence === pinned.sequence + 1
				? saved
				: nextTrustRecord(
						pinned,
						deps.now(),
						which === "record-signing"
							? { authorityKeys: wanted }
							: { witnessKeys: wanted },
					);
		const proposing: Progress = {
			...progress,
			proposal: Buffer.from(payload).toString("base64"),
		};
		await writeProgress(deps, which, proposing);
		const changed = await changeTrust(deps.trust, {
			payload,
			signer: signerOf(activeKey(signing.value)),
			reason: `rotate:${which}:${step}`,
		});
		if (!changed.ok) return changed;
		const { proposal: _proposal, ...rest } = proposing;
		return { ok: true, value: rest };
	}
	if (which === "token-signing")
		return failure(
			"invalid-request",
			"the token ring is published by rotateRing",
		);
	const published = await deps.nats.publish(
		which,
		slot.keys.map((key) => key.publicKey),
	);
	return published.ok ? { ok: true, value: progress } : published;
}

async function rotateSlot(
	deps: RotationDeps,
	which: RotatableKey,
	progress: Progress,
): Promise<Outcome<Reached>> {
	const read = await readSlot(deps.secrets, deps.prefix, which);
	if (!read.ok) return read;
	if (read.value === undefined)
		return failure(
			"invalid-request",
			`the key ${which} is not provisioned (no secret ${slotName(deps.prefix, which)})`,
		);
	let slot = read.value;
	let state = progress;

	if (state.reached === "done") {
		// Add. A key left by an interrupted add (held, newer than the active one) is reused.
		const pending = slot.keys.find(
			(key) => key.kid !== slot.active && key.kid === nextKidAfter(slot),
		);
		const oldKid = slot.active;
		const newKid = pending?.kid ?? nextKid(which, slot);
		if (pending === undefined) {
			slot = {
				active: slot.active,
				keys: [...slot.keys, freshKey(which, newKid)],
			};
			await writeSlot(deps.secrets, deps.prefix, which, slot);
		}
		state = { reached: "add", oldKid, newKid };
		await writeProgress(deps, which, state);
	}
	if (state.reached === "add") {
		const published = await publishSlot(deps, which, slot, state, "publish");
		if (!published.ok)
			return published.error.code === "unavailable"
				? { ok: true, value: "add" }
				: published;
		state = { ...published.value, reached: "publish" };
		await writeProgress(deps, which, state);
	}
	if (state.reached === "publish") {
		if (slot.active !== state.newKid) {
			slot = { active: state.newKid, keys: slot.keys };
			await writeSlot(deps.secrets, deps.prefix, which, slot);
		}
		state = { ...state, reached: "switch", switchedAtMs: deps.now() };
		await writeProgress(deps, which, state);
	}
	if (state.reached === "switch") {
		if (
			deps.now() <
			(state.switchedAtMs ?? 0) + (deps.graceMs ?? ROTATION_GRACE_MS)
		)
			return { ok: true, value: "switch" };
		const kept: KeySlot = {
			active: slot.active,
			keys: slot.keys.filter((key) => key.kid !== state.oldKid),
		};
		const published = await publishSlot(deps, which, kept, state, "remove");
		if (!published.ok)
			return published.error.code === "unavailable"
				? { ok: true, value: "switch" }
				: published;
		await writeSlot(deps.secrets, deps.prefix, which, kept);
		state = { ...published.value, reached: "remove" };
		await writeProgress(deps, which, state);
	}
	await writeProgress(deps, which, DONE);
	return { ok: true, value: "done" };
}

/** The key id an add of `slot` creates. */
function nextKidAfter(slot: KeySlot): string {
	const active = slot.active;
	const n = Number(active.slice(active.lastIndexOf("#") + 1));
	return `${active.slice(0, active.lastIndexOf("#") + 1)}${Number.isSafeInteger(n) ? n + 1 : 1}`;
}

/** Runs the rotation of `which` from the step it reached as far as it can go now. */
export async function rotate(
	deps: RotationDeps,
	which: RotatableKey,
): Promise<Outcome<Readonly<{ reached: Reached }>>> {
	if (KEY_KINDS[which] === undefined)
		return failure("invalid-request", `no rotatable key ${which}`);
	const progress = await readProgress(deps, which);
	if (!progress.ok) return progress;
	const reached =
		which === "token-signing"
			? await rotateRing(deps, progress.value)
			: await rotateSlot(deps, which, progress.value);
	return reached.ok ? { ok: true, value: { reached: reached.value } } : reached;
}
