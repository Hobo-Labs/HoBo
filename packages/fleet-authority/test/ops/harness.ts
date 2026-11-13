// A deployment for the operations tests: the memory bus with an audit log
// double that the witness can publish to (§11.3 rule 6: the memory bus keeps
// its witness path private), the real audit chain and witness of @hobo/fleet,
// keys from the secret store (as the ceremony left them), and signers that
// follow the active key of their slot the way a restarted process would.
import { create, toBinary } from "@bufbuild/protobuf";
import type { TenantId } from "@hobo/core";
import { parseTenantId } from "@hobo/core";
import {
	type AuditEntry,
	AuditEntrySchema,
	type AuditLog,
	type AuthorityBus,
	type FleetEventStore,
	KeyAlgorithm,
	type KeyId,
	KeyPurpose,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type Subscription,
	TRUST_RECORD_CONTEXT,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { createAuditChain, createWitness } from "@hobo/fleet/audit";
import { signEnvelope } from "@hobo/fleet/keys";
import { createMemoryBus } from "@hobo/fleet/testing";
import type { SecretsPort } from "@hobo/identity";
import type { RotatableKey } from "../../src/ops/index.js";
import { signWithSeed } from "../../src/ops/nkeys.js";
import {
	activeKey,
	freshKey,
	type HeldKey,
	keyRefOf,
	readSlot,
	signerOf,
	writeSlot,
} from "../../src/ops/slots.js";
import type { TrustDeps } from "../../src/ops/trust.js";

export const ISSUER = "https://authority.fleet.test";

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined) {
	return (
		a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b))
	);
}

type Listener<T> = {
	handler: (value: T) => Promise<void>;
	chain: Promise<void>;
};

function topic<T>() {
	const values: T[] = [];
	const listeners = new Set<Listener<T>>();
	return {
		values,
		publish(value: T) {
			values.push(value);
			for (const listener of listeners)
				listener.chain = listener.chain.then(() =>
					listener.handler(value).catch(() => {}),
				);
		},
		subscribe(handler: (value: T) => Promise<void>): Subscription {
			const listener: Listener<T> = { handler, chain: Promise.resolve() };
			for (const value of values)
				listener.chain = listener.chain.then(() =>
					handler(value).catch(() => {}),
				);
			listeners.add(listener);
			return {
				async stop() {
					listeners.delete(listener);
					await listener.chain;
				},
			};
		},
	};
}

/** An in-memory `AuditLog` plus the witness's publish path, pairing co-signatures by payload bytes. */
export function memoryAuditLog() {
	const entries: AuditEntry[] = [];
	const checkpoints = topic<SignedEnvelope>();
	const witnessed = topic<WitnessedEnvelope>();
	const proposed = topic<SignedEnvelope>();
	const trustWitnessed = topic<WitnessedEnvelope>();
	let pending: { cosignature: SignedEnvelope; of: "checkpoint" | "trust" }[] =
		[];
	const pair = () => {
		const waiting = pending;
		pending = [];
		for (const item of waiting) {
			const pool =
				item.of === "checkpoint" ? checkpoints.values : proposed.values;
			const authority = pool.find((candidate) =>
				sameBytes(candidate.payload, item.cosignature.payload),
			);
			if (authority === undefined) {
				pending.push(item);
				continue;
			}
			const pairValue = create(WitnessedEnvelopeSchema, {
				authority,
				witness: item.cosignature,
			});
			(item.of === "checkpoint" ? witnessed : trustWitnessed).publish(
				pairValue,
			);
		}
	};
	const log: AuditLog = {
		async append(entry) {
			entries.push(create(AuditEntrySchema, entry));
		},
		async appendCheckpoint(checkpoint) {
			checkpoints.publish(create(SignedEnvelopeSchema, checkpoint));
			pair();
		},
		async entries(from, to) {
			return entries.filter((e) => e.sequence >= from && e.sequence <= to);
		},
		onWitnessed: (handler) => witnessed.subscribe(handler),
		onCheckpoint: (handler) => checkpoints.subscribe(handler),
		async proposeTrust(record) {
			proposed.publish(create(SignedEnvelopeSchema, record));
			pair();
		},
		onTrustProposed: (handler) => proposed.subscribe(handler),
		onTrustWitnessed: (handler) => trustWitnessed.subscribe(handler),
	};
	return {
		log,
		entries,
		witnessed: witnessed.values,
		async publish(cosignature: SignedEnvelope, of: "checkpoint" | "trust") {
			pending.push({ cosignature, of });
			pair();
		},
	};
}

/** A `Signer` that signs with whichever key its slot names active, as of the last `refresh`. */
export function followingSigner(
	secrets: SecretsPort,
	prefix: string,
	which: RotatableKey,
) {
	let key: HeldKey | undefined;
	const refresh = async () => {
		const slot = await readSlot(secrets, prefix, which);
		if (!slot.ok || slot.value === undefined)
			throw new Error(`no slot ${which}`);
		key = activeKey(slot.value);
	};
	const current = (): HeldKey => {
		if (key === undefined) throw new Error("refresh the signer first");
		return key;
	};
	return {
		refresh,
		current,
		signer: {
			get keyId(): KeyId {
				return signerOf(current()).keyId;
			},
			algorithm: KeyAlgorithm.EDDSA,
			async sign(bytes: Uint8Array) {
				return signWithSeed(
					new Uint8Array(Buffer.from(current().seed, "base64url")),
					bytes,
				);
			},
		},
	};
}

/** Slots the ceremony does not create (provisioning stores the NATS account keys). */
export async function provisionNatsSlots(
	secrets: SecretsPort,
	prefix: string,
): Promise<void> {
	for (const which of [
		"account-signing",
		"scoped-observer",
		"scoped-executor",
		"scoped-dispatcher",
	] as const) {
		const key = freshKey(which, `${which}#1`);
		await writeSlot(secrets, prefix, which, { active: key.kid, keys: [key] });
	}
}

export type Deployment = Awaited<ReturnType<typeof deployment>>;

/**
 * A running deployment over `store`: genesis trust (sequence 1, incarnation 1)
 * from the slots unless `trust` is false, the authority's audit chain, and the
 * witness, started.
 */
export async function deployment(
	options: Readonly<{
		secrets: SecretsPort;
		prefix: string;
		store: FleetEventStore;
		now: () => number;
		tenant?: TenantId;
		genesis?: boolean;
		incarnation?: number;
	}>,
) {
	const tenant = options.tenant ?? parseTenantId("acme");
	const audit = memoryAuditLog();
	const memory = createMemoryBus(options.now);
	const bus: AuthorityBus = { ...memory, audit: audit.log };
	const record = followingSigner(
		options.secrets,
		options.prefix,
		"record-signing",
	);
	const witnessKey = followingSigner(
		options.secrets,
		options.prefix,
		"witness",
	);
	await record.refresh();
	await witnessKey.refresh();

	if (options.genesis !== false) {
		const payload = toBinary(
			TrustRecordSchema,
			create(TrustRecordSchema, {
				tenant,
				sequence: 1,
				authorityKeys: [keyRefOf(record.current(), KeyPurpose.AUTHORITY)],
				witnessKeys: [keyRefOf(witnessKey.current(), KeyPurpose.WITNESS)],
				authorityIncarnation: 1,
				issuer: ISSUER,
				jwksUri: `${ISSUER}/v1/fleet/jwks`,
				issuedAt: new Date(options.now()).toISOString(),
			}),
		);
		await bus.publisher.putTrust(
			create(WitnessedEnvelopeSchema, {
				authority: await signEnvelope(
					record.signer,
					TRUST_RECORD_CONTEXT,
					payload,
				),
				witness: await signEnvelope(
					witnessKey.signer,
					TRUST_RECORD_CONTEXT,
					payload,
				),
			}),
		);
	}

	const witnessLog: string[] = [];
	const witness = createWitness({
		log: audit.log,
		registryChanges: () => ({ async stop() {} }),
		trust: () => bus.registry.trust(),
		signer: witnessKey.signer,
		publish: audit.publish,
		now: options.now,
		log2: (event, fields) => {
			witnessLog.push(`${event} ${JSON.stringify(fields)}`);
		},
	});
	witness.start();

	let chain = createAuditChain({
		store: options.store,
		log: audit.log,
		signer: record.signer,
		incarnation: options.incarnation ?? 1,
		now: options.now,
	});
	const trustDeps = (witnessTimeoutMs = 10_000): TrustDeps => ({
		store: options.store,
		bus,
		tenant,
		tickAudit: () => chain.tick(),
		witnessTimeoutMs,
		now: options.now,
		log: () => {},
	});
	return {
		tenant,
		bus,
		audit,
		record,
		witnessKey,
		witness,
		witnessLog,
		trustDeps,
		/** The authority's audit chain, as its tick runs it. */
		tickAudit: () => chain.tick(),
		/** After a restart under a new incarnation. */
		restartChain(incarnation: number) {
			chain = createAuditChain({
				store: options.store,
				log: audit.log,
				signer: record.signer,
				incarnation,
				now: options.now,
			});
		},
		async stop() {
			await witness.stop();
		},
	};
}
