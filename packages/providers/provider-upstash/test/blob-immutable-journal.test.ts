import { createHash } from "node:crypto";
import {
	createImmutableJournal,
	type ImmutableJournalMember,
	type ImmutableJournalOptions,
} from "@hobo/backend-fleet";
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	assertUpstashBlobImmutableJournalWiring,
	createUpstashBlobImmutableJournalReplica,
	type UpstashBlobImmutableJournalOptions,
	upstashBlobImmutableJournalIdentity,
} from "../src/blob-immutable-journal.js";
import { createUpstashBlobJournalTransport } from "../src/blob-journal-transport.js";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
function fixture() {
	const now = 1_800_000_000_000;
	const accounts = ["a", "b", "c"];
	const members: ImmutableJournalMember[] = accounts.map((id) => ({
		id,
		provider: "upstash",
		accountId: `account-${id}`,
		resourceId: `hobo-journal-${id}`,
		incarnation: `inc-${id}`,
	}));
	const fleetId = "upstash-fleet",
		anchorDigest = hash(
			JSON.stringify({
				contract: "hobo.immutable-journal-anchor/v1",
				fleetId,
				members,
			}),
		);
	const objects = new Map<string, { body: string; etag: string }>(),
		calls: TransportRequest[] = [];
	const mintCharges: Parameters<
		UpstashBlobImmutableJournalOptions["authorizeMint"]
	>[0][] = [];
	const objectCharges: Parameters<
		UpstashBlobImmutableJournalOptions["authorizeObject"]
	>[0][] = [];
	const offlineBuckets = new Set<string>();
	let denyMint = false,
		denyObject = false,
		invalidateAfterPut = false,
		invalidateAfterMint = false,
		lostPath: string | undefined;
	let intercept: ((request: TransportRequest) => Promise<void>) | undefined;
	const transport: HttpTransport = async (request) => {
		calls.push(request);
		await intercept?.(request);
		const url = new URL(request.url);
		if (url.hostname === "blob.upstash.io") {
			const id = request.headers.authorization?.slice(-1),
				member = members.find((entry) => entry.id === id);
			if (!member) throw new Error("foreign token");
			if (invalidateAfterMint) denyMint = true;
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					endpoint: `https://${id?.repeat(32)}.r2.cloudflarestorage.com`,
					bucket: member.resourceId,
					region: "auto",
					visibility: "private",
					accessKeyId: `access-${id}`,
					secretAccessKey: `secret-${id}`,
					sessionToken: `session-${id}`,
					expiresAt: now / 1000 + 3600,
				}),
			};
		}
		if (
			!url.hostname.endsWith(".r2.cloudflarestorage.com") ||
			!request.headers.Authorization?.startsWith("AWS4-HMAC-SHA256")
		)
			throw new Error("unsigned request");
		if (offlineBuckets.has(url.pathname.split("/")[1] ?? ""))
			throw new Error("bucket unavailable");
		const prior = objects.get(request.url);
		if (request.method === "GET")
			return prior
				? { status: 200, body: prior.body, headers: { etag: prior.etag } }
				: { status: 404, body: "", headers: {} };
		if (request.method !== "PUT" || request.body === undefined)
			throw new Error("unexpected operation");
		if (
			(request.headers["if-none-match"] === "*" && prior) ||
			(request.headers["if-match"] !== undefined &&
				request.headers["if-match"] !== prior?.etag)
		)
			return { status: 412, headers: {}, body: "" };
		const etag = `"${hash(request.body)}"`;
		objects.set(request.url, { body: request.body, etag });
		if (invalidateAfterPut) denyObject = true;
		if (lostPath && url.pathname.endsWith(lostPath)) {
			lostPath = undefined;
			throw new Error("reply lost");
		}
		return { status: 200, headers: { etag }, body: "" };
	};
	const options = members.map(
		(member): UpstashBlobImmutableJournalOptions => ({
			member,
			fleetId,
			members,
			anchorDigest,
			initializationId: `init-${member.id}`,
			upstashAccountId: member.accountId,
			bucketId: member.resourceId,
			r2AccountId: member.id.repeat(32),
			credentialRef: `vault://upstash/${member.id}`,
			namespace: "journal/test",
			maxEntries: 100,
			maxLogBytes: 64_000,
			maxDocumentBytes: 64_000,
			maxObjectBytes: 128_000,
			now: () => now,
			transport,
			resolveToken: async () => `testtoken_${member.id}`,
			authorizeMint: async (charge) => {
				mintCharges.push(charge);
				if (denyMint) throw new Error("mint denied");
				return async () => {
					if (denyMint) throw new Error("mint revoked");
				};
			},
			authorizeObject: async (charge) => {
				objectCharges.push(charge);
				if (denyObject) throw new Error("object denied");
				return async () => {
					if (denyObject) throw new Error("object revoked");
				};
			},
		}),
	);
	const open = () => options.map(createUpstashBlobImmutableJournalReplica);
	const journal = (voters: ReturnType<typeof open>) =>
		createImmutableJournal({
			fleetId,
			members,
			anchorDigest,
			replicas: voters.map((voter) => voter.replica),
			maxEntryBytes: 4096,
			maxEntries: 100,
			authorize: async () => {},
		} satisfies ImmutableJournalOptions);
	return {
		options,
		members,
		objects,
		calls,
		mintCharges,
		objectCharges,
		open,
		journal,
		setDenyMint(value: boolean) {
			denyMint = value;
		},
		setDenyObject(value: boolean) {
			denyObject = value;
		},
		setInvalidateAfterMint(value: boolean) {
			invalidateAfterMint = value;
		},
		setInvalidateAfterPut(value: boolean) {
			invalidateAfterPut = value;
		},
		loseNext(path: string) {
			lostPath = path;
		},
		setIntercept(value: typeof intercept) {
			intercept = value;
		},
		setOffline(bucket: string, value: boolean) {
			if (value) offlineBuckets.add(bucket);
			else offlineBuckets.delete(bucket);
		},
	};
}

describe("Upstash private Blob immutable voter", () => {
	it("recovers an acknowledged tail after a voter outage and a different voter failure", async () => {
		const f = fixture(),
			voters = f.open();
		for (const voter of voters) await voter.initializeFresh(async () => {});
		const journal = f.journal(voters);
		await journal.bootstrap(async () => {});
		await journal.append("one", "first", 0);
		f.setOffline("hobo-journal-c", true);
		await journal.append("two", "second", 1);
		f.setOffline("hobo-journal-c", false);
		f.setOffline("hobo-journal-b", true);
		await expect(journal.read()).rejects.toThrow(/quorum-unavailable/u);
		expect((await journal.recover()).map((entry) => entry.value)).toEqual([
			"first",
			"second",
		]);
		await journal.append("three", "third", 2);
		expect((await journal.read()).map((entry) => entry.value)).toEqual([
			"first",
			"second",
			"third",
		]);
	});
	it("persists through restart and records its Cloudflare-correlated failure domains", async () => {
		const f = fixture(),
			voters = f.open();
		for (const voter of voters) await voter.initializeFresh(async () => {});
		const journal = f.journal(voters);
		await journal.bootstrap(async () => {});
		await journal.append("one", "payload", 0);
		const reopened = f.open(),
			reopenedReplica = reopened[0]?.replica;
		if (!reopenedReplica) throw new Error("missing voter");
		const identity = upstashBlobImmutableJournalIdentity(reopenedReplica);
		expect(identity).toMatchObject({
			upstashAccountId: "account-a",
			bucketId: "hobo-journal-a",
			failureDomains: [
				"upstash:account-a",
				"cloudflare",
				"cloudflare:r2",
				`cloudflare:r2:${"a".repeat(32)}`,
			],
		});
		const first = f.options[0],
			replica = reopened[0]?.replica;
		if (!first || !replica) throw new Error("missing voter");
		expect(() =>
			assertUpstashBlobImmutableJournalWiring(replica, first),
		).toThrow(/transport-unverified/u);
		const enrolled = {
			...first,
			transport: createUpstashBlobJournalTransport({
				r2AccountId: first.r2AccountId,
				bucketId: first.bucketId,
				namespace: first.namespace,
				maxObjectBytes: first.maxObjectBytes,
			}),
		};
		const enrolledReplica =
			createUpstashBlobImmutableJournalReplica(enrolled).replica;
		assertUpstashBlobImmutableJournalWiring(enrolledReplica, enrolled);
		expect(() =>
			assertUpstashBlobImmutableJournalWiring(enrolledReplica, {
				...enrolled,
				resolveToken: async () => "foreign",
			}),
		).toThrow(/wiring/u);
		expect(
			(await f.journal(reopened).read()).map((entry) => entry.value),
		).toEqual(["payload"]);
		expect(f.mintCharges[0]).toEqual({
			maxRequestBytes: 32_768,
			maxResponseBytes: 49_152,
		});
		expect(
			f.objectCharges.every(
				(charge) =>
					charge.maxRequestBytes >= 32_768 && charge.maxResponseBytes >= 32_768,
			),
		).toBe(true);
	});
	it("reconciles a lost conditional-write response without a second journal entry", async () => {
		const f = fixture(),
			voters = f.open();
		for (const voter of voters) await voter.initializeFresh(async () => {});
		const journal = f.journal(voters);
		await journal.bootstrap(async () => {});
		f.loseNext("/assignments");
		const result = await journal.append("one", "payload", 0);
		expect((await journal.append("one", "payload", 0)).digest).toBe(
			result.digest,
		);
		expect((await journal.read()).map((entry) => entry.value)).toEqual([
			"payload",
		]);
	});
	it("uses ETag fencing to reject a delayed old writer after a seal", async () => {
		const f = fixture(),
			voters = f.open();
		for (const voter of voters) await voter.initializeFresh(async () => {});
		const journal = f.journal(voters);
		await journal.bootstrap(async () => {});
		await journal.append("one", "payload", 0);
		const voter = voters[0]?.replica;
		if (!voter) throw new Error("missing voter");
		const [head] = await voter.read(1);
		if (!head) throw new Error("missing head");
		const digest = head.reason.split(":")[2];
		if (!digest) throw new Error("missing digest");
		let release = () => {},
			signal = () => {},
			blocked = true;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			signal = resolve;
		});
		f.setIntercept(async (request) => {
			if (
				blocked &&
				request.method === "PUT" &&
				request.url.includes("hobo-journal-a/") &&
				request.url.endsWith("/assignments")
			) {
				blocked = false;
				signal();
				await gate;
			}
		});
		const delayed = journal.append("two", "late", 1);
		await started;
		expect(
			await voter.seal({ transitionId: "cutover", epoch: head.epoch, digest }),
		).toBe("sealed");
		release();
		await delayed;
		expect((await voter.read()).length).toBe(head.epoch);
		await expect(voter.writeDocument(hash("late"), "late")).rejects.toThrow(
			/sealed/u,
		);
	});
	it("refuses missing identity, unavailable funding and revoked mint authority", async () => {
		const f = fixture(),
			first = f.open()[0];
		if (!first) throw new Error("missing voter");
		await expect(first.replica.read()).rejects.toThrow();
		const denied = fixture(),
			deniedVoter = denied.open()[0];
		if (!deniedVoter) throw new Error("missing voter");
		denied.setDenyMint(true);
		await expect(deniedVoter.initializeFresh(async () => {})).rejects.toThrow();
		expect(denied.calls).toHaveLength(0);
		const revoked = fixture(),
			revokedVoter = revoked.open()[0];
		if (!revokedVoter) throw new Error("missing voter");
		revoked.setInvalidateAfterMint(true);
		await expect(
			revokedVoter.initializeFresh(async () => {}),
		).rejects.toThrow();
		expect(
			revoked.calls.every(
				(call) => new URL(call.url).hostname === "blob.upstash.io",
			),
		).toBe(true);
	});
	it("does not send an R2 operation when its separate hold is unavailable", async () => {
		const f = fixture(),
			first = f.open()[0];
		if (!first) throw new Error("missing voter");
		f.setDenyObject(true);
		await expect(first.initializeFresh(async () => {})).rejects.toThrow();
		expect(f.calls).toHaveLength(1);
		expect(new URL(f.calls[0]?.url ?? "").hostname).toBe("blob.upstash.io");
	});
	it("retains an ambiguous committed put when its operation authority is revoked", async () => {
		const f = fixture(),
			first = f.open()[0];
		if (!first) throw new Error("missing voter");
		f.setInvalidateAfterPut(true);
		await expect(first.initializeFresh(async () => {})).rejects.toThrow();
		expect(f.objects.size).toBe(1);
		f.setInvalidateAfterPut(false);
		f.setDenyObject(false);
		await first.initializeFresh(async () => {});
		expect(f.objects.size).toBe(1);
	});
	it("rejects a corrupted immutable document and never initializes without fresh authority", async () => {
		const f = fixture(),
			voters = f.open(),
			first = voters[0];
		if (!first) throw new Error("missing voter");
		await expect(
			first.initializeFresh(async () => {
				throw new Error("not fresh");
			}),
		).rejects.toThrow(/freshness/u);
		expect(f.calls).toHaveLength(0);
		for (const voter of voters) await voter.initializeFresh(async () => {});
		await f.journal(voters).bootstrap(async () => {});
		const key = [...f.objects.keys()].find(
			(url) => url.includes("hobo-journal-a/") && url.includes("/documents/"),
		);
		if (!key) throw new Error("missing test document");
		const prior = f.objects.get(key),
			digest = key.split("/").at(-1);
		if (!prior || !digest) throw new Error("missing test document");
		f.objects.set(key, { ...prior, body: "corrupt" });
		await expect(first.replica.readDocument(digest)).rejects.toThrow(
			/invalid-document/u,
		);
	});
	it("never cold-initializes a lost voter or assumes a foreign bucket belongs to Upstash", async () => {
		const f = fixture(),
			first = f.open()[0],
			options = f.options[0];
		if (!first || !options) throw new Error("missing voter");
		await first.initializeFresh(async () => {});
		for (const key of f.objects.keys())
			if (key.includes("hobo-journal-a/")) f.objects.delete(key);
		await expect(f.open()[0]?.replica.read()).rejects.toThrow(
			/identity-unverified/u,
		);
		expect(() =>
			createUpstashBlobImmutableJournalReplica({
				...options,
				member: { ...options.member, provider: "vercel" },
			}),
		).toThrow(/configuration/u);
	});
});
