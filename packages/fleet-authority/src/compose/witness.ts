/**
 * The witness (§6.14, §6.16): `createWitness` over its own bus connection
 * (the witness's static-user credentials), its key from the `witness` slot
 * (re-read after a rotation switch), and the registry changes it sees itself
 * (`pollRegistryChanges`). In the standalone profile it runs on the same host
 * under another operating-system account; in high availability on another
 * host. It holds no event store.
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	type AuthorityBus,
	type Clock,
	type FleetLog,
	type Outcome,
	type SignedEnvelope,
	type TrustRecord,
	TrustRecordSchema,
} from "@hobo/fleet";
import { createWitness } from "@hobo/fleet/audit";
import type { connectAuthorityBus } from "@hobo/fleet-nats";
import type { SecretsPort } from "@hobo/identity";
import type { AuthorityConfig } from "./config.js";
import { followingSigner, requireSecret, slotSigner } from "./keys.js";
import { pollRegistryChanges } from "./registry-changes.js";

export type WitnessAdapters = Readonly<{
	secrets: SecretsPort;
	now: Clock;
	log: FleetLog;
	connectBus: typeof connectAuthorityBus;
	/** Writes a co-signature to `fleet.audit.witness`; `publishOverAuditLog` unless given. */
	publish?(
		bus: AuthorityBus,
		cosignature: SignedEnvelope,
		of: "checkpoint" | "trust",
	): Promise<void>;
}>;

/**
 * The witness's publish path over its own bus connection: a connection opened
 * with the witness user's credentials appends co-signatures, so
 * `appendCheckpoint` and `proposeTrust` write the co-signature of a
 * checkpoint or of a trust record to `fleet.audit.witness` (@hobo/fleet-nats,
 * `connectAuthorityBus`), the one subject the witness user may publish.
 */
export function publishOverAuditLog(
	bus: AuthorityBus,
	cosignature: SignedEnvelope,
	of: "checkpoint" | "trust",
): Promise<void> {
	return of === "checkpoint"
		? bus.audit.appendCheckpoint(cosignature)
		: bus.audit.proposeTrust(cosignature);
}

function trustOf(bus: AuthorityBus | undefined): TrustRecord {
	const payload = bus?.registry.trustEnvelope()?.authority?.payload;
	return payload === undefined
		? create(TrustRecordSchema)
		: fromBinary(TrustRecordSchema, payload);
}

export async function composeWitness(
	config: AuthorityConfig,
	adapters: WitnessAdapters,
): Promise<Outcome<Readonly<{ start(): void; stop(): Promise<void> }>>> {
	const credentials = await requireSecret(
		adapters.secrets,
		config.witnessNatsCredentialsSecret,
	);
	if (!credentials.ok) return credentials;
	const key = await slotSigner(
		adapters.secrets,
		config.secretPrefix,
		"witness",
		adapters.now,
	);
	if (!key.ok) return key;
	let bus: AuthorityBus | undefined;
	bus = await adapters.connectBus({
		servers: config.record.natsUrls,
		credentials: credentials.value,
		trust: () => trustOf(bus),
		log: adapters.log,
	});
	const connected = bus;
	await connected.registry.caughtUp();
	const witness = createWitness({
		log: connected.audit,
		registryChanges: pollRegistryChanges(connected.registry),
		trust: () => connected.registry.trust(),
		signer: followingSigner(key.value),
		publish: (cosignature, of) =>
			(adapters.publish ?? publishOverAuditLog)(connected, cosignature, of),
		now: adapters.now,
		log2: adapters.log,
	});
	return {
		ok: true,
		value: {
			start: () => witness.start(),
			async stop() {
				await witness.stop();
				await connected.close();
			},
		},
	};
}
