// Backup and restore (design §6.16, F6): the event store and `FLEET_AUDIT` in
// one archive with a manifest of digests; a restore loads it into a fresh
// deployment, rebuilds the registry, and increments the authority
// incarnation through a witnessed trust record, so every credential issued
// before the restore is refused (`incarnation-stale`). Private to L27.
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { canonicalJson, type JsonObject } from "@hobo/core";
import {
	AuditCheckpointsSchema,
	AuditEntriesSchema,
	type AuditEntry,
	type AuthorityBus,
	type Clock,
	type FleetEventStore,
	type FleetLog,
	type Outcome,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { createAuditChain } from "@hobo/fleet/audit";
import type { SecretsPort } from "@hobo/identity";
import type { Profile } from "./config.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	numberField,
	parseJson,
	stringField,
} from "./json.js";
import { rebuildRegistry } from "./rebuild.js";
import { activeKey, readSlot, signerOf } from "./slots.js";
import { changeTrust, nextTrustRecord } from "./trust.js";

// public-contract: the archive format `hobo fleet ops backup` writes and `restore` reads.
export const ARCHIVE_FORMAT = "hobo-fleet-backup/v1";
const AUDIT_PAGE = 1_000;
/** How long the archive waits for the retained witnessed checkpoints to stop arriving. */
const SETTLE_MS = 100;

/** How the deployment's journal is copied: `sqlite`, a consistent SQLite snapshot; `jsonl`, every envelope in `readAll` order. */
export type JournalArchiver = Readonly<{
	format: "sqlite" | "jsonl";
	dump(): Promise<Uint8Array>;
	/** Loads the copy into a fresh deployment; `conflict` when the store is not fresh, nothing to do when it already holds this copy. */
	load(bytes: Uint8Array, manifestDigest: string): Promise<Outcome<void>>;
}>;

export type ArchiveDeps = Readonly<{
	tenant: string;
	profile: Profile;
	journal: JournalArchiver;
	/** The deployment's event store; for a restore, opened after the journal is loaded. */
	store(): Promise<FleetEventStore>;
	bus: Pick<AuthorityBus, "registry" | "publisher" | "audit">;
	secrets: SecretsPort;
	prefix: string;
	witnessTimeoutMs: number;
	now: Clock;
	log: FleetLog;
}>;

// domain-view: one part of the archive as its manifest lists it.
type PartEntry = Readonly<{ name: string; sha256: string; bytes: number }>;
// domain-view: the archive's manifest; its canonical JSON's SHA-256 is the manifest digest.
type Manifest = Readonly<{
	format: string;
	tenant: string;
	profile: Profile;
	journalFormat: "sqlite" | "jsonl";
	createdAt: string;
	trustSequence: number;
	incarnation: number;
	parts: readonly PartEntry[];
}>;

const PART = {
	journal: "journal",
	entries: "audit-entries",
	checkpoints: "audit-checkpoints",
	trust: "trust",
} as const;

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function manifestJson(manifest: Manifest): JsonObject {
	return {
		format: manifest.format,
		tenant: manifest.tenant,
		profile: manifest.profile,
		journalFormat: manifest.journalFormat,
		createdAt: manifest.createdAt,
		trustSequence: manifest.trustSequence,
		incarnation: manifest.incarnation,
		parts: manifest.parts.map((part) => ({
			name: part.name,
			sha256: part.sha256,
			bytes: part.bytes,
		})),
	};
}

export function manifestDigestOf(manifest: Manifest): string {
	return sha256(canonicalJson(manifestJson(manifest)));
}

function invalid<T>(
	message: string,
	detail?: Record<string, string>,
): Outcome<T> {
	return detail === undefined
		? { ok: false, error: { code: "invalid-request", message } }
		: { ok: false, error: { code: "invalid-request", message, detail } };
}

/** Every audit entry from 1, in order. */
async function allEntries(deps: ArchiveDeps): Promise<AuditEntry[]> {
	const out: AuditEntry[] = [];
	for (let from = 1; ; from += AUDIT_PAGE) {
		const page = await deps.bus.audit.entries(from, from + AUDIT_PAGE - 1);
		out.push(...page);
		if (page.length < AUDIT_PAGE) return out;
	}
}

/** The witnessed checkpoints the audit log retains, collected until they stop arriving. */
async function witnessedCheckpoints(
	deps: Pick<ArchiveDeps, "bus">,
	atLeast = 0,
	timeoutMs = 2_000,
): Promise<WitnessedEnvelope[]> {
	const seen: WitnessedEnvelope[] = [];
	let lastAt = Date.now();
	const subscription = deps.bus.audit.onWitnessed(async (checkpoint) => {
		seen.push(checkpoint);
		lastAt = Date.now();
	});
	const started = Date.now();
	try {
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS / 2));
			const quiet = Date.now() - lastAt >= SETTLE_MS;
			if (
				(quiet && seen.length >= atLeast) ||
				Date.now() - started >= timeoutMs
			)
				return seen;
		}
	} finally {
		await subscription.stop();
	}
}

export async function backupArchive(
	deps: ArchiveDeps,
	archivePath: string,
): Promise<Outcome<Readonly<{ manifestDigest: string }>>> {
	const trust = deps.bus.registry.trustEnvelope();
	if (trust?.authority === undefined)
		return {
			ok: false,
			error: {
				code: "unavailable",
				message: "the registry pins no trust record",
			},
		};
	const record = fromBinary(TrustRecordSchema, trust.authority.payload);
	// Audit first, journal last: the journal then holds every event the audit log has an entry for.
	const checkpoints = await witnessedCheckpoints(deps);
	const entries = await allEntries(deps);
	const journal = await deps.journal.dump();
	const parts = {
		[PART.journal]: journal,
		[PART.entries]: toBinary(
			AuditEntriesSchema,
			create(AuditEntriesSchema, { entries }),
		),
		[PART.checkpoints]: toBinary(
			AuditCheckpointsSchema,
			create(AuditCheckpointsSchema, { checkpoints }),
		),
		[PART.trust]: toBinary(WitnessedEnvelopeSchema, trust),
	};
	const manifest: Manifest = {
		format: ARCHIVE_FORMAT,
		tenant: deps.tenant,
		profile: deps.profile,
		journalFormat: deps.journal.format,
		createdAt: new Date(deps.now()).toISOString(),
		trustSequence: record.sequence,
		incarnation: record.authorityIncarnation,
		parts: Object.entries(parts).map(([name, bytes]) => ({
			name,
			sha256: sha256(bytes),
			bytes: bytes.length,
		})),
	};
	const body = JSON.stringify({
		manifest: manifestJson(manifest),
		parts: Object.fromEntries(
			Object.entries(parts).map(([name, bytes]) => [
				name,
				Buffer.from(bytes).toString("base64"),
			]),
		),
	});
	const temporary = `${archivePath}.partial`;
	await writeFile(temporary, body, { mode: 0o600 });
	await rename(temporary, archivePath);
	return { ok: true, value: { manifestDigest: manifestDigestOf(manifest) } };
}

type Archive = Readonly<{
	manifest: Manifest;
	digest: string;
	parts: ReadonlyMap<string, Uint8Array>;
}>;

function parseManifest(value: JsonObject): Manifest | undefined {
	const format = stringField(value, "format");
	const tenant = stringField(value, "tenant");
	const profile = stringField(value, "profile");
	const journalFormat = stringField(value, "journalFormat");
	const createdAt = stringField(value, "createdAt");
	const trustSequence = numberField(value, "trustSequence");
	const incarnation = numberField(value, "incarnation");
	const list = value.parts;
	if (
		format === undefined ||
		tenant === undefined ||
		(profile !== "standalone" && profile !== "high-availability") ||
		(journalFormat !== "sqlite" && journalFormat !== "jsonl") ||
		createdAt === undefined ||
		trustSequence === undefined ||
		incarnation === undefined ||
		!isJsonArray(list)
	)
		return undefined;
	const parts: PartEntry[] = [];
	for (const item of list) {
		if (!isJsonObject(item)) return undefined;
		const name = stringField(item, "name");
		const digest = stringField(item, "sha256");
		const bytes = numberField(item, "bytes");
		if (name === undefined || digest === undefined || bytes === undefined)
			return undefined;
		parts.push({ name, sha256: digest, bytes });
	}
	return {
		format,
		tenant,
		profile,
		journalFormat,
		createdAt,
		trustSequence,
		incarnation,
		parts,
	};
}

export async function readArchive(
	archivePath: string,
): Promise<Outcome<Archive>> {
	let text: string;
	try {
		text = await readFile(archivePath, "utf8");
	} catch {
		return invalid(`cannot read the archive ${archivePath}`);
	}
	const value = parseJson(text);
	const manifest =
		isJsonObject(value) && isJsonObject(value.manifest)
			? parseManifest(value.manifest)
			: undefined;
	const encoded = isJsonObject(value) ? value.parts : undefined;
	if (manifest === undefined || !isJsonObject(encoded))
		return invalid("the file is not a fleet backup archive");
	if (manifest.format !== ARCHIVE_FORMAT)
		return invalid(
			`the archive format ${manifest.format} is not ${ARCHIVE_FORMAT}`,
		);
	const parts = new Map<string, Uint8Array>();
	for (const part of manifest.parts) {
		const text64 = encoded[part.name];
		if (!isJsonString(text64))
			return invalid(`the archive lacks the part ${part.name}`, {
				part: part.name,
			});
		const bytes = new Uint8Array(Buffer.from(text64, "base64"));
		if (bytes.length !== part.bytes || sha256(bytes) !== part.sha256)
			return invalid(`the part ${part.name} does not match its digest`, {
				part: part.name,
				rule: "digest",
			});
		parts.set(part.name, bytes);
	}
	for (const name of Object.values(PART))
		if (!parts.has(name))
			return invalid(`the archive lacks the part ${name}`, { part: name });
	return {
		ok: true,
		value: { manifest, digest: manifestDigestOf(manifest), parts },
	};
}

function part(archive: Archive, name: string): Uint8Array {
	// readArchive checked every part of PART is present.
	return archive.parts.get(name) ?? new Uint8Array();
}

/** Puts the restored audit log back: its entries, then the authority half of each checkpoint, which the witness co-signs again. */
async function restoreAudit(
	deps: ArchiveDeps,
	entries: readonly AuditEntry[],
	checkpoints: readonly WitnessedEnvelope[],
): Promise<Outcome<void>> {
	const present = await allEntries(deps);
	if (present.length === 0) {
		for (const entry of entries) await deps.bus.audit.append(entry);
		for (const checkpoint of checkpoints)
			if (checkpoint.authority !== undefined)
				await deps.bus.audit.appendCheckpoint(checkpoint.authority);
		return { ok: true, value: undefined };
	}
	const same =
		present.length >= entries.length &&
		entries.every(
			(entry, i) =>
				present[i]?.eventId === entry.eventId &&
				present[i]?.previousHash === entry.previousHash,
		);
	return same
		? { ok: true, value: undefined }
		: {
				ok: false,
				error: {
					code: "conflict",
					message:
						"the deployment's audit log holds other entries; restore needs a fresh deployment",
				},
			};
}

export async function restoreArchive(
	deps: ArchiveDeps,
	archivePath: string,
): Promise<Outcome<Readonly<{ incarnation: number }>>> {
	const read = await readArchive(archivePath);
	if (!read.ok) return read;
	const archive = read.value;
	if (archive.manifest.tenant !== deps.tenant)
		return invalid(
			`the archive is of tenant ${archive.manifest.tenant}, not ${deps.tenant}`,
		);
	if (archive.manifest.journalFormat !== deps.journal.format)
		return invalid(
			`the archive's journal is ${archive.manifest.journalFormat}; this deployment restores ${deps.journal.format}`,
		);
	const archivedTrust = fromBinary(
		WitnessedEnvelopeSchema,
		part(archive, PART.trust),
	);
	const archivedRecord = fromBinary(
		TrustRecordSchema,
		archivedTrust.authority?.payload ?? new Uint8Array(),
	);
	const entries = fromBinary(
		AuditEntriesSchema,
		part(archive, PART.entries),
	).entries;
	const checkpoints = fromBinary(
		AuditCheckpointsSchema,
		part(archive, PART.checkpoints),
	).checkpoints;

	const loaded = await deps.journal.load(
		part(archive, PART.journal),
		archive.digest,
	);
	if (!loaded.ok) return loaded;
	const store = await deps.store();
	// The archived trust first: the witness judges the restored checkpoints against it.
	if (deps.bus.registry.trust().sequence < archivedRecord.sequence)
		await deps.bus.publisher.putTrust(archivedTrust);
	const audit = await restoreAudit(deps, entries, checkpoints);
	if (!audit.ok) return audit;

	const signing = await readSlot(deps.secrets, deps.prefix, "record-signing");
	if (!signing.ok) return signing;
	if (signing.value === undefined)
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: "the record-signing key is not in the secret store",
			},
		};
	const signer = signerOf(activeKey(signing.value));

	let pinned = deps.bus.registry.trust();
	if (pinned.sequence === archivedRecord.sequence) {
		// The witness co-signs the restored checkpoints under the archived incarnation, before it changes.
		const recosigned = await witnessedCheckpoints(
			deps,
			checkpoints.length,
			deps.witnessTimeoutMs,
		);
		if (recosigned.length < checkpoints.length)
			return {
				ok: false,
				error: {
					code: "unavailable",
					message: `the witness co-signed ${recosigned.length} of ${checkpoints.length} restored checkpoints; run restore again once it is up`,
				},
			};
		const chain = createAuditChain({
			store,
			log: deps.bus.audit,
			signer,
			incarnation: pinned.authorityIncarnation,
			now: deps.now,
		});
		const changed = await changeTrust(
			{
				store,
				bus: deps.bus,
				tenant: deps.tenant,
				tickAudit: () => chain.tick(),
				witnessTimeoutMs: deps.witnessTimeoutMs,
				now: deps.now,
				log: deps.log,
			},
			{
				payload: nextTrustRecord(pinned, deps.now(), {
					authorityIncarnation: pinned.authorityIncarnation + 1,
				}),
				signer,
				reason: "restore",
			},
		);
		if (!changed.ok) return changed;
		pinned = deps.bus.registry.trust();
	}
	await rebuildRegistry({
		store,
		publisher: deps.bus.publisher,
		signer,
		incarnation: pinned.authorityIncarnation,
		now: deps.now,
	});
	return { ok: true, value: { incarnation: pinned.authorityIncarnation } };
}
