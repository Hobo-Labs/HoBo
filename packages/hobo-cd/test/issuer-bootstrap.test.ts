import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { JwtSvidIssuer, verifyJwtWithJwks } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	type CdIssuerWinner,
	createIssuerCandidatesFromSecrets,
	createIssuerJournalFromEventStore,
	createIssuerKms,
	createRandomIssuerCandidatesFromSecrets,
	type IssuerEventStore,
	openCdIssuer,
	type PrivateIssuerCandidates,
	type PrivateIssuerJournal,
	prepareCdIssuer,
} from "../src/issuer-bootstrap.js";

const origin = "https://cd.fixture.test";

class Candidates implements PrivateIssuerCandidates {
	readonly values = new Map<string, string>();
	private next = 0;
	failAfterCreate = false;
	async createCandidate(material: string): Promise<string> {
		const reference = `candidate-${++this.next}`;
		if (this.values.has(reference)) throw new Error("duplicate candidate");
		this.values.set(reference, material);
		if (this.failAfterCreate) {
			this.failAfterCreate = false;
			throw new Error("synthetic private-fixture.invalid candidate failure");
		}
		return reference;
	}
	async readCandidate(reference: string): Promise<string | undefined> {
		return this.values.get(reference);
	}
}

class Journal implements PrivateIssuerJournal {
	winner: CdIssuerWinner | undefined;
	claimFailure: "before" | "after" | undefined;
	readFailure = false;
	async readWinner(): Promise<CdIssuerWinner | undefined> {
		if (this.readFailure)
			throw new Error("synthetic private-fixture.invalid journal failure");
		return this.winner;
	}
	async claimWinner(candidate: CdIssuerWinner): Promise<"created" | "exists"> {
		if (this.claimFailure === "before") {
			this.claimFailure = undefined;
			throw new Error("synthetic private-fixture.invalid before claim");
		}
		if (this.winner) return "exists";
		this.winner = Object.freeze({ ...candidate });
		if (this.claimFailure === "after") {
			this.claimFailure = undefined;
			throw new Error("synthetic private-fixture.invalid lost receipt");
		}
		return "created";
	}
}

class JournalStore implements IssuerEventStore {
	events: Array<{
		streamId: string;
		tenant: string;
		seq: number;
		type: string;
		v: number;
		data: unknown;
	}> = [];
	loseReceipt = false;
	async *read() {
		for (const event of this.events) yield event;
	}
	async append(
		streamId: string,
		events: Parameters<IssuerEventStore["append"]>[1],
		options: Parameters<IssuerEventStore["append"]>[2],
	) {
		if (options.expectedSeq !== this.events.length)
			throw new Error("synthetic contention");
		const first = events[0];
		if (!first || events.length !== 1)
			throw new Error("invalid fixture append");
		const event = {
			streamId,
			tenant: options.tenant,
			seq: 1,
			type: first.type,
			v: first.v,
			data: first.data,
		};
		this.events.push(event);
		if (this.loseReceipt) {
			this.loseReceipt = false;
			throw new Error("synthetic secret-fixture lost receipt");
		}
		return { streamId, appended: [event], deduped: [] };
	}
}

class DelayedJournalStore extends JournalStore {
	delayed: (() => Promise<void>) | undefined;
	private first = true;
	async append(
		streamId: string,
		events: Parameters<IssuerEventStore["append"]>[1],
		options: Parameters<IssuerEventStore["append"]>[2],
	) {
		if (this.first) {
			this.first = false;
			this.delayed = async () => {
				await super.append(streamId, events, options);
			};
			throw new Error("synthetic delayed receipt");
		}
		return await super.append(streamId, events, options);
	}
}

function verifies(payload: Uint8Array, signature: Uint8Array, key: KeyObject) {
	return createVerify("RSA-SHA256")
		.update(payload)
		.end()
		.verify(key, signature);
}

describe("private CD issuer bootstrap", () => {
	it("refuses a random-candidate adapter without canonical-name verification", () => {
		const incomplete = {
			async put() {
				return { versionId: "version" };
			},
			async access() {
				return { status: "denied" as const, code: "secret-not-found" };
			},
			async supportsExactName() {
				return true;
			},
		};
		expect(() =>
			// @ts-expect-error
			createRandomIssuerCandidatesFromSecrets(incomplete),
		).toThrow(expect.objectContaining({ code: "cd-issuer-unavailable" }));
	});
	it("refuses unsupported candidate names before accessing or writing", async () => {
		let accesses = 0;
		let writes = 0;
		const candidates = createRandomIssuerCandidatesFromSecrets({
			async put() {
				writes += 1;
				return { versionId: "version" };
			},
			async access() {
				accesses += 1;
				return { status: "denied", code: "secret-not-found" };
			},
			async supportsExactName() {
				return false;
			},
			async canonicalName(name) {
				return name;
			},
		});
		await expect(
			candidates.createCandidate("synthetic value"),
		).rejects.toThrow();
		expect(accesses).toBe(0);
		expect(writes).toBe(0);
	});
	it("skips an observed random-name collision without overwriting it", async () => {
		const seen: string[] = [];
		const written: string[] = [];
		const values = new Map<string, string>();
		let firstRead = true;
		const candidates = createRandomIssuerCandidatesFromSecrets({
			async put(name, material) {
				written.push(name);
				values.set(name, material);
				return { versionId: "version" };
			},
			async access(name) {
				seen.push(name);
				if (firstRead) {
					firstRead = false;
					return {
						status: "ok",
						material: "synthetic existing",
						versionId: "version",
					};
				}
				const material = values.get(name);
				return material
					? { status: "ok", material, versionId: "version" }
					: { status: "denied", code: "secret-not-found" };
			},
			async canonicalName(name) {
				return name;
			},
			async supportsExactName() {
				return true;
			},
		});
		const reference = await candidates.createCandidate("synthetic new value");
		expect(written).toHaveLength(1);
		expect(written[0] === seen[0]).toBe(false);
		expect(reference === written[0]).toBe(true);
		expect(reference).toMatch(/^HOBO_CD_ISSUER_[A-F0-9]{64}$/u);
	});

	it.each([
		"name",
		"value",
	] as const)("refuses an observed random-candidate %s mismatch", async (mismatch) => {
		let value: string | undefined;
		const candidates = createRandomIssuerCandidatesFromSecrets({
			async put(_name, material) {
				value = material;
				return { versionId: "version" };
			},
			async access() {
				return value === undefined
					? { status: "denied", code: "secret-not-found" }
					: {
							status: "ok",
							material: mismatch === "value" ? "synthetic mismatch" : value,
							versionId: "version",
						};
			},
			async canonicalName(name) {
				return mismatch === "name" ? name.slice(0, 20) : name;
			},
			async supportsExactName() {
				return true;
			},
		});
		await expect(
			candidates.createCandidate("synthetic new value"),
		).rejects.toThrow();
	});

	it("retries only the same candidate value and a late write cannot replace the winner", async () => {
		const values = new Map<string, string>();
		const writes: Array<{ name: string; value: string }> = [];
		let delayed: (() => void) | undefined;
		const candidates = createRandomIssuerCandidatesFromSecrets({
			async put(name, material) {
				writes.push({ name, value: material });
				if (writes.length === 1) {
					delayed = () => values.set(name, material);
					throw new Error("synthetic lost write response");
				}
				values.set(name, material);
				return { versionId: "version" };
			},
			async access(name) {
				const material = values.get(name);
				return material
					? { status: "ok", material, versionId: "version" }
					: { status: "denied", code: "secret-not-found" };
			},
			async canonicalName(name) {
				return name;
			},
			async supportsExactName() {
				return true;
			},
		});
		const journal = new Journal();
		const key = await prepareCdIssuer({ origin, candidates, journal });
		expect(writes).toHaveLength(2);
		expect(writes[0]?.name === writes[1]?.name).toBe(true);
		expect(writes[0]?.value === writes[1]?.value).toBe(true);
		if (!delayed) throw new Error("missing delayed fixture write");
		delayed();
		const reopened = await openCdIssuer({ origin, candidates, journal });
		expect(reopened.keyId).toBe(key.keyId);
		key.close();
		reopened.close();
	});
	it("signs an SVID that a restarted replica verifies with its own reopened key", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		const first = await prepareCdIssuer({ origin, candidates, journal });
		const restarted = await openCdIssuer({ origin, candidates, journal });
		expect(() =>
			createIssuerKms({ ...first, keyId: "0".repeat(64) }),
		).toThrow();
		const issuer = new JwtSvidIssuer({
			issuerUrl: origin,
			kms: createIssuerKms(first),
			activeKeyId: first.keyId,
			jwksKeyIds: [first.keyId],
		});
		const verifier = new JwtSvidIssuer({
			issuerUrl: origin,
			kms: createIssuerKms(restarted),
			activeKeyId: restarted.keyId,
			jwksKeyIds: [restarted.keyId],
		});
		const token = await issuer.signJwtSvid({
			sub: "spiffe://fixture/reconciler/one",
			aud: "fixture-agent",
			tenant: "fixture",
			parentPrincipal: { kind: "service", id: "fixture" },
			codeVersion: { digest: "fixture", version: "fixture" },
			scope: [],
			iat: 100,
			nbf: 100,
			exp: 200,
		});
		const verified = await verifyJwtWithJwks(token, verifier.jwks(), {
			issuer: origin,
			audience: "fixture-agent",
			now: 150,
		});
		expect(verified.claims.sub).toBe("spiffe://fixture/reconciler/one");
		const kms = createIssuerKms(first);
		first.close();
		expect(kms.hasKey(first.keyId)).toBe(false);
		expect(() => kms.sign(first.keyId, "fixture")).toThrow();
		expect(() => createIssuerKms(first)).toThrow();
		restarted.close();
	});
	it("uses a supplied atomic event store to select one winner across contenders", async () => {
		const store = new JournalStore();
		const candidates = new Candidates();
		const journal = createIssuerJournalFromEventStore({
			store,
			streamId: "fixture-stream",
			tenant: "fixture-tenant",
		});
		const keys = await Promise.all(
			Array.from({ length: 4 }, () =>
				prepareCdIssuer({ origin, candidates, journal }),
			),
		);
		expect(new Set(keys.map((key) => key.keyId)).size).toBe(1);
		expect(store.events).toHaveLength(1);
		for (const key of keys) key.close();
	});

	it("recovers an atomic append whose receipt was lost", async () => {
		const store = new JournalStore();
		store.loseReceipt = true;
		const candidates = new Candidates();
		const journal = createIssuerJournalFromEventStore({
			store,
			streamId: "fixture-stream",
			tenant: "fixture-tenant",
		});
		const key = await prepareCdIssuer({ origin, candidates, journal });
		expect(store.events).toHaveLength(1);
		expect((await openCdIssuer({ origin, candidates, journal })).keyId).toBe(
			key.keyId,
		);
		key.close();
	});

	it("never replaces a later winner when an earlier ambiguous append finishes late", async () => {
		const store = new DelayedJournalStore();
		const candidates = new Candidates();
		const journal = createIssuerJournalFromEventStore({
			store,
			streamId: "fixture-stream",
			tenant: "fixture-tenant",
		});
		await expect(
			prepareCdIssuer({ origin, candidates, journal }),
		).rejects.toThrow();
		const winner = await prepareCdIssuer({ origin, candidates, journal });
		if (!store.delayed) throw new Error("missing delayed fixture append");
		await expect(store.delayed()).rejects.toThrow();
		const reopened = await openCdIssuer({ origin, candidates, journal });
		expect(reopened.keyId).toBe(winner.keyId);
		expect(store.events).toHaveLength(1);
		expect(candidates.values.size).toBe(2);
		winner.close();
		reopened.close();
	});

	it("refuses corrupt journal histories rather than choosing a new winner", async () => {
		const store = new JournalStore();
		const candidates = new Candidates();
		const journal = createIssuerJournalFromEventStore({
			store,
			streamId: "fixture-stream",
			tenant: "fixture-tenant",
		});
		const key = await prepareCdIssuer({ origin, candidates, journal });
		key.close();
		const first = store.events[0];
		if (!first) throw new Error("missing fixture event");
		store.events.push({ ...first, seq: 2 });
		await expect(
			prepareCdIssuer({ origin, candidates, journal }),
		).rejects.toThrow();
		expect(candidates.values.size).toBe(1);
	});
	it("requires atomic candidate creation from the selected owner store", async () => {
		const access = async () => ({
			status: "denied" as const,
			code: "secret-not-found",
		});
		expect(() => createIssuerCandidatesFromSecrets({ access })).toThrow(
			expect.objectContaining({ code: "cd-issuer-unavailable" }),
		);
	});

	it("creates unique candidates without overwriting on a name collision", async () => {
		const seen: string[] = [];
		const values = new Map<string, string>();
		const candidates = createIssuerCandidatesFromSecrets({
			async createOnly(name, value) {
				seen.push(name);
				if (seen.length === 1) return { created: false };
				values.set(name, value);
				return { created: true };
			},
			async access(name) {
				const material = values.get(name);
				return material === undefined
					? { status: "denied", code: "secret-not-found" }
					: { status: "ok", material };
			},
		});
		const reference = await candidates.createCandidate(
			"synthetic private material",
		);
		expect(seen).toHaveLength(2);
		expect(new Set(seen).size).toBe(2);
		expect(reference).toMatch(/^HOBO_CD_ISSUER_[A-F0-9]{32}$/u);
		expect(await candidates.readCandidate(reference)).toBe(
			"synthetic private material",
		);
	});
	it("converges concurrent private candidates on one atomically chosen key", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		const keys = await Promise.all(
			Array.from({ length: 5 }, () =>
				prepareCdIssuer({ origin, candidates, journal }),
			),
		);
		const first = keys[0];
		if (!first) throw new Error("missing fixture key");
		const reference = journal.winner?.candidateReference;
		if (!reference) throw new Error("missing fixture reference");
		const privateMaterial = candidates.values.get(reference);
		if (!privateMaterial) throw new Error("missing fixture material");
		expect(new Set(keys.map((key) => key.keyId)).size).toBe(1);
		expect(candidates.values.size).toBeGreaterThan(1);
		const message = Buffer.from("synthetic payload");
		for (const key of keys) {
			expect(verifies(message, key.sign(message), first.publicKey)).toBe(true);
			const output = JSON.stringify(key);
			expect(output.includes(privateMaterial)).toBe(false);
			expect(output.includes(reference)).toBe(false);
			key.close();
			expect(() => key.sign(message)).toThrow();
		}
	});

	it.each([
		"missing",
		"corrupted",
		"different-key",
	] as const)("does not claim an unreadable or mismatched candidate: %s", async (failure) => {
		let claims = 0;
		let creates = 0;
		const journal: PrivateIssuerJournal = {
			async readWinner() {
				return undefined;
			},
			async claimWinner() {
				claims += 1;
				return "created";
			},
		};
		const candidates: PrivateIssuerCandidates = {
			async createCandidate() {
				creates += 1;
				return "synthetic-private-candidate";
			},
			async readCandidate() {
				if (failure === "missing") return undefined;
				if (failure === "corrupted") return "synthetic invalid key";
				return generateKeyPairSync("rsa", { modulusLength: 2048 })
					.privateKey.export({ format: "pem", type: "pkcs8" })
					.toString();
			},
		};
		await expect(
			prepareCdIssuer({ origin, candidates, journal }),
		).rejects.toThrow(
			expect.objectContaining({ code: "cd-issuer-unavailable" }),
		);
		expect(creates).toBe(1);
		expect(claims).toBe(0);
	});

	it("reopens the same winner on every replica and rejects a different origin", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		const first = await prepareCdIssuer({ origin, candidates, journal });
		const reopened = await openCdIssuer({ origin, candidates, journal });
		expect(reopened.keyId).toBe(first.keyId);
		first.close();
		expect(
			verifies(
				Buffer.from("payload"),
				reopened.sign(Buffer.from("payload")),
				reopened.publicKey,
			),
		).toBe(true);
		await expect(
			openCdIssuer({
				origin: "https://other.fixture.test",
				candidates,
				journal,
			}),
		).rejects.toThrow();
		expect(candidates.values.size).toBe(1);
		reopened.close();
	});

	it("never creates a key during runtime open when no winner exists", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		await expect(
			openCdIssuer({ origin, candidates, journal }),
		).rejects.toThrow();
		expect(candidates.values.size).toBe(0);
		expect(journal.winner).toBeUndefined();
	});

	it("recovers a committed winner after a lost claim response", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		journal.claimFailure = "after";
		const key = await prepareCdIssuer({ origin, candidates, journal });
		expect(key.keyId).toBe(journal.winner?.keyId);
		expect(candidates.values.size).toBe(1);
		key.close();
	});

	it("leaves a candidate untouched after a failed claim and retries with a fresh candidate", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		journal.claimFailure = "before";
		await expect(
			prepareCdIssuer({ origin, candidates, journal }),
		).rejects.toThrow();
		expect(journal.winner).toBeUndefined();
		expect(candidates.values.size).toBe(1);
		const key = await prepareCdIssuer({ origin, candidates, journal });
		expect(candidates.values.size).toBe(2);
		expect(key.keyId).toBe(journal.winner?.keyId);
		key.close();
	});

	it("leaves a candidate untouched when creation loses its response", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		candidates.failAfterCreate = true;
		await expect(
			prepareCdIssuer({ origin, candidates, journal }),
		).rejects.toThrow();
		expect(journal.winner).toBeUndefined();
		const key = await prepareCdIssuer({ origin, candidates, journal });
		expect(candidates.values.size).toBe(2);
		key.close();
	});

	it("refuses missing, replaced, or unsuitable winner material without creating a replacement", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		const first = await prepareCdIssuer({ origin, candidates, journal });
		first.close();
		const reference = journal.winner?.candidateReference;
		if (!reference) throw new Error("missing fixture winner");
		candidates.values.delete(reference);
		await expect(
			openCdIssuer({ origin, candidates, journal }),
		).rejects.toThrow();
		candidates.values.set(
			reference,
			generateKeyPairSync("rsa", { modulusLength: 2048 })
				.privateKey.export({ format: "pem", type: "pkcs8" })
				.toString(),
		);
		await expect(
			openCdIssuer({ origin, candidates, journal }),
		).rejects.toThrow();
		candidates.values.set(
			reference,
			generateKeyPairSync("ec", { namedCurve: "P-256" })
				.privateKey.export({ format: "pem", type: "pkcs8" })
				.toString(),
		);
		await expect(
			openCdIssuer({ origin, candidates, journal }),
		).rejects.toThrow();
		expect(candidates.values.size).toBe(1);
	});

	it("does not expose owner store or journal failures in errors", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		journal.readFailure = true;
		let caught: unknown;
		try {
			await prepareCdIssuer({ origin, candidates, journal });
		} catch (error) {
			caught = error;
		}
		expect(String(caught)).not.toContain("private-fixture.invalid");
		expect(caught).not.toHaveProperty("cause");
		expect(candidates.values.size).toBe(0);
	});

	it("redacts synthetic secret material and candidate references from provider errors", async () => {
		const candidates = new Candidates();
		const journal = new Journal();
		const key = await prepareCdIssuer({ origin, candidates, journal });
		key.close();
		const reference = journal.winner?.candidateReference;
		if (!reference) throw new Error("missing fixture reference");
		const syntheticSecret = "synthetic-secret-never-print";
		candidates.readCandidate = async () => {
			throw new Error(`${syntheticSecret} ${reference}`);
		};
		let caught: unknown;
		try {
			await openCdIssuer({ origin, candidates, journal });
		} catch (error) {
			caught = error;
		}
		const rendered =
			caught instanceof Error
				? `${caught.message}\n${caught.stack}`
				: String(caught);
		expect(rendered.includes(syntheticSecret)).toBe(false);
		expect(rendered.includes(reference)).toBe(false);
		expect(caught).not.toHaveProperty("cause");
	});

	it("redacts synthetic secret material from a failed owner-store candidate write", async () => {
		const syntheticSecret = "synthetic-secret-never-print";
		const journal = new Journal();
		const candidates = createIssuerCandidatesFromSecrets({
			async createOnly() {
				throw new Error(syntheticSecret);
			},
			async access() {
				return { status: "denied", code: "secret-not-found" };
			},
		});
		let caught: unknown;
		try {
			await prepareCdIssuer({ origin, candidates, journal });
		} catch (error) {
			caught = error;
		}
		const rendered =
			caught instanceof Error
				? `${caught.message}\n${caught.stack}`
				: String(caught);
		expect(rendered.includes(syntheticSecret)).toBe(false);
		expect(caught).not.toHaveProperty("cause");
		expect(journal.winner).toBeUndefined();
	});
});
