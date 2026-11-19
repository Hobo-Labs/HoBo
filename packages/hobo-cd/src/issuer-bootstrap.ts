import {
	createHash,
	createPrivateKey,
	createPublicKey,
	createSign,
	generateKeyPair,
	type KeyObject,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { z } from "zod";

const winnerSchema = z
	.object({
		schemaVersion: z.literal("hobo.cd.issuer-winner/v1"),
		originHash: z.string().regex(/^[a-f0-9]{64}$/u),
		candidateReference: z.string().min(1).max(2048),
		keyId: z.string().regex(/^[a-f0-9]{64}$/u),
	})
	.strict();

export type CdIssuerWinner = z.infer<typeof winnerSchema>;

export interface PrivateIssuerCandidates {
	createCandidate(material: string): Promise<string>;
	readCandidate(reference: string): Promise<string | undefined>;
}

export type IssuerSecretStore = Readonly<{
	createOnly?(name: string, material: string): Promise<{ created: boolean }>;
	access(
		name: string,
	): Promise<
		| Readonly<{ status: "ok"; material?: string; versionId?: string }>
		| Readonly<{ status: "denied"; code: string }>
	>;
}>;

export type RandomIssuerSecretStore = IssuerSecretStore &
	Readonly<{
		put(name: string, material: string): Promise<{ versionId: string }>;
		supportsExactName(name: string): Promise<boolean>;
		canonicalName(name: string, versionId: string): Promise<string | undefined>;
	}>;

export interface PrivateIssuerJournal {
	readWinner(): Promise<CdIssuerWinner | undefined>;
	claimWinner(winner: CdIssuerWinner): Promise<"created" | "exists">;
}

export type IssuerJournalEvent = Readonly<{
	streamId: string;
	tenant: string;
	seq: number;
	type: string;
	v: number;
	data: unknown;
}>;

export interface IssuerEventStore {
	read(streamId: string): AsyncIterable<IssuerJournalEvent>;
	append(
		streamId: string,
		events: Array<{ type: string; v: number; data: CdIssuerWinner }>,
		options: {
			expectedSeq: number;
			actor: { kind: "system"; id: string };
			tenant: string;
		},
	): Promise<{
		streamId: string;
		appended: readonly IssuerJournalEvent[];
		deduped: readonly IssuerJournalEvent[];
	}>;
}

export type CdIssuerBootstrapInput = Readonly<{
	origin: string;
	candidates: PrivateIssuerCandidates;
	journal: PrivateIssuerJournal;
}>;

export type CdIssuerSigningKey = Readonly<{
	keyId: string;
	publicKey: KeyObject;
	available(): boolean;
	sign(payload: string | Uint8Array): Buffer;
	close(): void;
}>;

export type CdIssuerKms = Readonly<{
	hasKey(keyId: string): boolean;
	generateRsaKey(keyId: string): void;
	sign(keyId: string, payload: string): Buffer;
	publicJwk(keyId: string): Readonly<{
		kty: "RSA";
		n: string;
		e: string;
		kid: string;
		alg: "RS256";
		use: "sig";
	}>;
}>;

function unavailable(): Error {
	return Object.assign(
		new Error("The private CD issuer could not be established."),
		{
			code: "cd-issuer-unavailable",
		},
	);
}

const CANDIDATE_NAME = /^HOBO_CD_ISSUER_(?:[A-Fa-f0-9]{32}|[A-Fa-f0-9]{64})$/u;

export function createIssuerKms(key: CdIssuerSigningKey): CdIssuerKms {
	if (
		!key.available() ||
		key.publicKey.asymmetricKeyType !== "rsa" ||
		(key.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
		fingerprint(key.publicKey) !== key.keyId
	)
		throw unavailable();
	const jwk = key.publicKey.export({ format: "jwk" });
	if (!jwk.n || !jwk.e) throw unavailable();
	const publicJwk = Object.freeze({
		kty: "RSA" as const,
		n: jwk.n,
		e: jwk.e,
		kid: key.keyId,
		alg: "RS256" as const,
		use: "sig" as const,
	});
	return Object.freeze({
		hasKey(keyId: string) {
			return keyId === key.keyId && key.available();
		},
		generateRsaKey() {
			throw unavailable();
		},
		sign(keyId: string, payload: string) {
			if (keyId !== key.keyId) throw unavailable();
			return key.sign(payload);
		},
		publicJwk(keyId: string) {
			if (keyId !== key.keyId) throw unavailable();
			return publicJwk;
		},
	});
}

export function createIssuerCandidatesFromSecrets(
	store: IssuerSecretStore,
): PrivateIssuerCandidates {
	const createOnly = store.createOnly;
	if (!createOnly) throw unavailable();
	return Object.freeze({
		async createCandidate(material: string) {
			try {
				for (let attempt = 0; attempt < 8; attempt += 1) {
					const reference = `HOBO_CD_ISSUER_${randomUUID().replaceAll("-", "").toUpperCase()}`;
					const result = await createOnly.call(store, reference, material);
					if (result.created === true) return reference;
					if (result.created !== false) throw unavailable();
				}
			} catch {
				throw unavailable();
			}
			throw unavailable();
		},
		async readCandidate(reference: string) {
			try {
				if (!CANDIDATE_NAME.test(reference)) throw unavailable();
				const result = await store.access(reference);
				if (result.status === "ok" && result.material) return result.material;
				if (result.status === "denied" && result.code === "secret-not-found")
					return undefined;
				throw unavailable();
			} catch {
				throw unavailable();
			}
		},
	});
}

export function createRandomIssuerCandidatesFromSecrets(
	store: RandomIssuerSecretStore,
): PrivateIssuerCandidates {
	if (
		!store.put ||
		!store.access ||
		!store.supportsExactName ||
		!store.canonicalName
	)
		throw unavailable();
	const read = async (reference: string): Promise<string | undefined> => {
		if (
			!CANDIDATE_NAME.test(reference) ||
			(await store.supportsExactName(reference)) !== true
		)
			throw unavailable();
		const result = await store.access(reference);
		if (result.status === "denied" && result.code === "secret-not-found")
			return undefined;
		if (
			result.status !== "ok" ||
			!result.material ||
			!result.versionId ||
			(await store.canonicalName(reference, result.versionId)) !== reference
		)
			throw unavailable();
		return result.material;
	};
	return Object.freeze({
		async createCandidate(material: string) {
			try {
				for (let attempt = 0; attempt < 8; attempt += 1) {
					const reference = `HOBO_CD_ISSUER_${randomBytes(32).toString("hex").toUpperCase()}`;
					if ((await read(reference)) !== undefined) continue;
					for (let write = 0; write < 3; write += 1) {
						try {
							await store.put(reference, material);
						} catch {}
						const observed = await read(reference);
						if (observed === material) return reference;
						if (observed !== undefined) throw unavailable();
					}
					throw unavailable();
				}
			} catch {
				throw unavailable();
			}
			throw unavailable();
		},
		async readCandidate(reference: string) {
			try {
				return await read(reference);
			} catch {
				throw unavailable();
			}
		},
	});
}

export function createIssuerJournalFromEventStore(
	input: Readonly<{
		store: IssuerEventStore;
		streamId: string;
		tenant: string;
	}>,
): PrivateIssuerJournal {
	if (
		!input.streamId ||
		input.streamId.length > 2048 ||
		!input.tenant ||
		input.tenant.length > 2048
	)
		throw unavailable();
	const eventType = "cd.IssuerWinner";
	const read = async (): Promise<CdIssuerWinner | undefined> => {
		let winner: CdIssuerWinner | undefined;
		for await (const event of input.store.read(input.streamId)) {
			if (
				winner ||
				event.streamId !== input.streamId ||
				event.tenant !== input.tenant ||
				event.seq !== 1 ||
				event.type !== eventType ||
				event.v !== 1
			)
				throw unavailable();
			const parsed = winnerSchema.safeParse(event.data);
			if (!parsed.success) throw unavailable();
			winner = parsed.data;
		}
		return winner;
	};
	return Object.freeze({
		async readWinner() {
			try {
				return await read();
			} catch {
				throw unavailable();
			}
		},
		async claimWinner(winner: CdIssuerWinner) {
			const parsed = winnerSchema.safeParse(winner);
			if (!parsed.success) throw unavailable();
			try {
				const result = await input.store.append(
					input.streamId,
					[{ type: eventType, v: 1, data: parsed.data }],
					{
						expectedSeq: 0,
						actor: { kind: "system", id: "hobo-cd-issuer" },
						tenant: input.tenant,
					},
				);
				const event = result.appended[0];
				if (
					result.streamId !== input.streamId ||
					result.appended.length !== 1 ||
					result.deduped.length !== 0 ||
					!event ||
					event.streamId !== input.streamId ||
					event.tenant !== input.tenant ||
					event.seq !== 1 ||
					event.type !== eventType ||
					event.v !== 1
				)
					throw unavailable();
				return "created" as const;
			} catch {
				try {
					if (await read()) return "exists" as const;
				} catch {}
				throw unavailable();
			}
		},
	});
}

function originHash(value: string): string {
	const origin = new URL(value);
	if (
		origin.protocol !== "https:" ||
		origin.origin !== value ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw unavailable();
	return createHash("sha256")
		.update("hobo-cd-issuer/v1\0")
		.update(origin.origin)
		.digest("hex");
}

function fingerprint(publicKey: KeyObject): string {
	return createHash("sha256")
		.update(publicKey.export({ format: "der", type: "spki" }))
		.digest("hex");
}

async function readWinner(
	journal: PrivateIssuerJournal,
	expectedOriginHash: string,
): Promise<CdIssuerWinner | undefined> {
	const value = await journal.readWinner();
	if (value === undefined) return undefined;
	const parsed = winnerSchema.safeParse(value);
	if (!parsed.success || parsed.data.originHash !== expectedOriginHash)
		throw unavailable();
	return parsed.data;
}

async function openWinner(
	candidates: PrivateIssuerCandidates,
	winner: CdIssuerWinner,
): Promise<CdIssuerSigningKey> {
	const material = await candidates.readCandidate(winner.candidateReference);
	if (!material || Buffer.byteLength(material) > 32_768) throw unavailable();
	let privateKey: KeyObject | undefined = createPrivateKey(material);
	if (
		privateKey.asymmetricKeyType !== "rsa" ||
		(privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
	)
		throw unavailable();
	const publicKey = createPublicKey(privateKey);
	if (fingerprint(publicKey) !== winner.keyId) throw unavailable();
	return Object.freeze({
		keyId: winner.keyId,
		publicKey,
		available() {
			return privateKey !== undefined;
		},
		sign(payload: string | Uint8Array) {
			if (!privateKey) throw new Error("The CD issuer key is closed.");
			return createSign("RSA-SHA256").update(payload).end().sign(privateKey);
		},
		close() {
			privateKey = undefined;
		},
	});
}

function makeKeyPair(): Promise<{
	privateKey: KeyObject;
	publicKey: KeyObject;
}> {
	return new Promise((resolve, reject) => {
		generateKeyPair(
			"rsa",
			{ modulusLength: 2048 },
			(error, publicKey, privateKey) => {
				if (error) reject(error);
				else resolve({ privateKey, publicKey });
			},
		);
	});
}

export async function openCdIssuer(
	input: CdIssuerBootstrapInput,
): Promise<CdIssuerSigningKey> {
	try {
		const winner = await readWinner(input.journal, originHash(input.origin));
		if (!winner) throw unavailable();
		return await openWinner(input.candidates, winner);
	} catch {
		throw unavailable();
	}
}

export async function prepareCdIssuer(
	input: CdIssuerBootstrapInput,
): Promise<CdIssuerSigningKey> {
	try {
		const scope = originHash(input.origin);
		const existing = await readWinner(input.journal, scope);
		if (existing) return await openWinner(input.candidates, existing);
		const pair = await makeKeyPair();
		const material = pair.privateKey
			.export({ format: "pem", type: "pkcs8" })
			.toString();
		const candidate = winnerSchema.parse({
			schemaVersion: "hobo.cd.issuer-winner/v1",
			originHash: scope,
			candidateReference: await input.candidates.createCandidate(material),
			keyId: fingerprint(pair.publicKey),
		});
		const verifiedCandidate = await openWinner(input.candidates, candidate);
		verifiedCandidate.close();
		let created = false;
		try {
			const result = await input.journal.claimWinner(candidate);
			if (result !== "created" && result !== "exists") throw unavailable();
			created = result === "created";
		} catch {
			const recovered = await readWinner(input.journal, scope);
			if (!recovered) throw unavailable();
			return await openWinner(input.candidates, recovered);
		}
		const winner = await readWinner(input.journal, scope);
		if (
			!winner ||
			(created &&
				(winner.candidateReference !== candidate.candidateReference ||
					winner.keyId !== candidate.keyId))
		)
			throw unavailable();
		return await openWinner(input.candidates, winner);
	} catch {
		throw unavailable();
	}
}
