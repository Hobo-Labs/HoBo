import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assessMeshTrust,
	claimTurn,
	createMemoryMesh,
	createMeshCoordinator,
	createMeshMonitor,
	createTrustedMeshBoard,
	effectiveMeshTrust,
	fitJob,
	generateMeshIdentity,
	MESH_PUBLIC_KEY,
	MESH_SIGNATURE,
	type MeshJob,
	type MeshNode,
	type MeshTrustPolicy,
	meshAdvertSigningPayload,
	meshIdentityFromPem,
	rankNodes,
	signMeshAdvert,
	verifyMeshAdvert,
} from "../src/mesh/index.js";

const NOW = 1_800_000_000_000;

const node = (id: string, overrides: Partial<MeshNode> = {}): MeshNode => ({
	id,
	freeSlots: 2,
	totalSlots: 4,
	healthy: true,
	labels: ["hobo"],
	validUntilMs: NOW + 45_000,
	free: { memoryMb: 8_192, diskMb: 120_000 },
	platform: { os: "linux", arch: "x64" },
	reliability: 0.875,
	samples: { delivered: 10, dropped: 2 },
	sinceMs: NOW - 60_000,
	...overrides,
});
const job = (jobId: number): MeshJob => ({
	jobId,
	label: "hobo",
	queuedAtMs: NOW,
});
const ids = (nodes: readonly MeshNode[]) => nodes.map((entry) => entry.id);

const a = generateMeshIdentity();
const b = generateMeshIdentity();
const trusting = (...keys: string[]): MeshTrustPolicy => ({
	trustedKeys: keys.map((publicKey) => ({ publicKey })),
	requireTrusted: false,
});

describe("a node's identity", () => {
	it("is an Ed25519 key whose public half is 32 bytes of base64url", () => {
		expect(a.identity.publicKey).toMatch(MESH_PUBLIC_KEY);
		expect(a.identity.publicKey).not.toBe(b.identity.publicKey);
		expect(a.privateKeyPem).toContain("BEGIN PRIVATE KEY");
	});

	it("is the same identity when read back from its stored key", () => {
		const restored = meshIdentityFromPem(a.privateKeyPem);
		expect(restored.publicKey).toBe(a.identity.publicKey);
		// Ed25519 is deterministic: the same key signs the same bytes the same way.
		expect(restored.sign("payload")).toBe(a.identity.sign("payload"));
	});

	it("refuses a stored key that is not Ed25519", () => {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		expect(() =>
			meshIdentityFromPem(
				privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
			),
		).toThrow("Ed25519");
	});
});

describe("signing an advertisement", () => {
	it("attaches the key and a signature that verifies", () => {
		const signed = signMeshAdvert(node("box-a"), a.identity);
		expect(signed.identity?.publicKey).toBe(a.identity.publicKey);
		expect(signed.identity?.signature).toMatch(MESH_SIGNATURE);
		expect(verifyMeshAdvert(signed)).toBe("valid");
	});

	it("never carries the private key, in the advertisement or what is signed", () => {
		const signed = signMeshAdvert(node("box-a"), a.identity);
		const secret = a.privateKeyPem
			.split("\n")
			.filter((line) => line !== "" && !line.startsWith("-----"))
			.join("");
		expect(secret.length).toBeGreaterThan(40);
		expect(JSON.stringify(signed)).not.toContain(secret);
		expect(
			meshAdvertSigningPayload(signed, a.identity.publicKey),
		).not.toContain(secret);
	});

	it("covers the node id, the expiry, the key and every figure a reader ranks by", () => {
		const payload = meshAdvertSigningPayload(node("box-a"), "KEY");
		expect(JSON.parse(payload)).toEqual([
			"hobo-ci-mesh-advert/v1",
			"box-a",
			NOW + 45_000,
			2,
			4,
			true,
			["hobo"],
			8_192,
			120_000,
			"linux",
			"x64",
			0.875,
			10,
			2,
			NOW - 60_000,
			"KEY",
		]);
		// An absent figure is null, which a zero is not.
		expect(
			JSON.parse(
				meshAdvertSigningPayload(
					{
						id: "old",
						freeSlots: 0,
						healthy: false,
						labels: [],
						validUntilMs: 1,
					},
					"KEY",
				),
			),
		).toEqual([
			"hobo-ci-mesh-advert/v1",
			"old",
			1,
			0,
			null,
			false,
			[],
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			"KEY",
		]);
	});

	it("does not sign what only a reader computes, and drops it from what is sent", () => {
		const signed = signMeshAdvert(
			node("box-a", { trust: "trusted", seenAtMs: NOW }),
			a.identity,
		);
		expect(signed.trust).toBeUndefined();
		expect(signed.seenAtMs).toBeUndefined();
		// A reader annotating the advertisement does not break its signature.
		expect(verifyMeshAdvert({ ...signed, trust: "invalid", seenAtMs: 5 })).toBe(
			"valid",
		);
	});
});

describe("verifying an advertisement", () => {
	const signed = signMeshAdvert(node("box-a"), a.identity);

	it("rejects any change to what was signed", () => {
		const tampered: Partial<MeshNode>[] = [
			{ freeSlots: 64 },
			{ totalSlots: 64 },
			{ healthy: false },
			{ labels: ["hobo", "hobo-trunk"] },
			{ free: { memoryMb: 512_000, diskMb: 120_000 } },
			{ free: { memoryMb: 8_192, diskMb: 9_000_000 } },
			{ free: { memoryMb: 8_192 } },
			{ platform: { os: "linux", arch: "arm64" } },
			{ reliability: 1 },
			{ samples: { delivered: 1000, dropped: 0 } },
			{ sinceMs: NOW },
		];
		for (const change of tampered)
			expect(
				verifyMeshAdvert({ ...signed, ...change }),
				JSON.stringify(change),
			).toBe("invalid");
	});

	it("cannot be re-attributed to another node id", () => {
		expect(verifyMeshAdvert({ ...signed, id: "box-b" })).toBe("invalid");
	});

	it("cannot be given a later expiry, so a replay ends when the original did", () => {
		// Replayed unchanged, the signature still holds, and the expiry it
		// signed is the one a reader goes by: past it the node is stale.
		expect(verifyMeshAdvert(signed)).toBe("valid");
		expect(fitJob(job(1), signed, signed.validUntilMs - 1).copies).toBe(2);
		expect(fitJob(job(1), signed, signed.validUntilMs)).toEqual({
			copies: 0,
			lacking: "stale",
		});
		// Extending it is the only way to keep it alive, and that breaks the signature.
		expect(
			verifyMeshAdvert({
				...signed,
				validUntilMs: signed.validUntilMs + 60_000,
			}),
		).toBe("invalid");
	});

	it("rejects another key's signature and a key swapped in under a good signature", () => {
		const other = signMeshAdvert(node("box-a"), b.identity);
		expect(
			verifyMeshAdvert({
				...signed,
				identity: {
					publicKey: a.identity.publicKey,
					signature: other.identity?.signature ?? "",
				},
			}),
		).toBe("invalid");
		expect(
			verifyMeshAdvert({
				...signed,
				identity: {
					publicKey: b.identity.publicKey,
					signature: signed.identity?.signature ?? "",
				},
			}),
		).toBe("invalid");
	});

	it("calls a malformed key or signature invalid, and a missing one unsigned", () => {
		for (const identity of [
			{ publicKey: "", signature: "" },
			{ publicKey: "short", signature: signed.identity?.signature ?? "" },
			{ publicKey: a.identity.publicKey, signature: "not-a-signature" },
			{ publicKey: "!".repeat(43), signature: "!".repeat(86) },
		])
			expect(verifyMeshAdvert({ ...signed, identity })).toBe("invalid");
		expect(verifyMeshAdvert(node("old-node"))).toBe("unsigned");
	});
});

describe("how far a reader trusts a node", () => {
	const signed = signMeshAdvert(node("box-a"), a.identity);

	it("is trusted when its key is in the set, unverified when it is not", () => {
		expect(assessMeshTrust(signed, trusting(a.identity.publicKey))).toBe(
			"trusted",
		);
		expect(assessMeshTrust(signed, trusting(b.identity.publicKey))).toBe(
			"unverified",
		);
		expect(assessMeshTrust(signed, trusting())).toBe("unverified");
	});

	it("is invalid when the signature fails, whatever the set says", () => {
		expect(
			assessMeshTrust(
				{ ...signed, freeSlots: 64 },
				trusting(a.identity.publicKey),
			),
		).toBe("invalid");
	});

	it("treats a node that does not sign (an older version) as unverified", () => {
		expect(
			assessMeshTrust(
				{
					id: "box-old",
					freeSlots: 3,
					healthy: true,
					labels: ["hobo"],
					validUntilMs: NOW + 45_000,
				},
				trusting(a.identity.publicKey),
			),
		).toBe("unverified");
	});

	it("trusts a key bound to a node id for that id only", () => {
		const bound: MeshTrustPolicy = {
			trustedKeys: [{ publicKey: a.identity.publicKey, nodeId: "box-a" }],
			requireTrusted: false,
		};
		expect(assessMeshTrust(signed, bound)).toBe("trusted");
		// The same key, validly signing as another node: unknown there, not forged.
		expect(
			assessMeshTrust(signMeshAdvert(node("box-z"), a.identity), bound),
		).toBe("unverified");
	});

	it("trusts only itself when the mesh lists no keys", () => {
		expect(effectiveMeshTrust(undefined, a.identity.publicKey)).toEqual({
			trustedKeys: [{ publicKey: a.identity.publicKey }],
			requireTrusted: false,
		});
		// A list with no keys is no list, but its requirement still stands.
		expect(
			effectiveMeshTrust(
				{ trustedKeys: [], requireTrusted: true },
				a.identity.publicKey,
			),
		).toEqual({
			trustedKeys: [{ publicKey: a.identity.publicKey }],
			requireTrusted: true,
		});
		expect(effectiveMeshTrust(undefined, undefined).trustedKeys).toEqual([]);
		const listed = trusting(b.identity.publicKey);
		expect(effectiveMeshTrust(listed, a.identity.publicKey)).toBe(listed);
	});
});

describe("ranking by trust", () => {
	const trusted = node("trusted", { trust: "trusted" });
	const unverified = node("unverified", { trust: "unverified" });
	const unchecked = node("unchecked");
	const invalid = node("invalid", { trust: "invalid", freeSlots: 64 });
	const all = [trusted, unverified, unchecked, invalid];

	it("never ranks a node whose signature failed", () => {
		for (let jobId = 1; jobId <= 500; jobId += 1)
			expect(ids(rankNodes(job(jobId), all, NOW))).not.toContain("invalid");
		expect(fitJob(job(1), invalid, NOW)).toEqual({
			copies: 0,
			lacking: "trust",
		});
	});

	it("ranks unverified and unchecked nodes as before, unless trust is required", () => {
		expect(ids(rankNodes(job(1), all, NOW)).sort()).toEqual([
			"trusted",
			"unchecked",
			"unverified",
		]);
		expect(ids(rankNodes(job(1), all, NOW, { requireTrusted: true }))).toEqual([
			"trusted",
		]);
		expect(fitJob(job(1), unverified, NOW, { requireTrusted: true })).toEqual({
			copies: 0,
			lacking: "trust",
		});
	});

	it("always ranks the node itself, which needs nobody's signature", () => {
		const self = node("self");
		expect(
			claimTurn({
				job: job(7),
				self,
				peers: [unverified, invalid],
				nowMs: NOW,
				stepMs: 20_000,
				requireTrusted: true,
			}),
		).toEqual({ start: true, rank: 0, reason: "alone" });
		// A forged advertisement under this node's own id does not unseat it.
		expect(
			claimTurn({
				job: job(7),
				self,
				peers: [{ ...self, trust: "invalid", freeSlots: 0 }],
				nowMs: NOW,
				stepMs: 20_000,
			}),
		).toEqual({ start: true, rank: 0, reason: "alone" });
	});
});

describe("a board that signs and assesses", () => {
	function mesh() {
		const memory = createMemoryMesh({ now: () => NOW });
		let policy = trusting(a.identity.publicKey);
		const boardOf = (identity?: typeof a.identity) =>
			createTrustedMeshBoard({
				board: memory.board,
				identity,
				policy: () => policy,
			});
		return {
			memory,
			boardOf,
			setPolicy(next: MeshTrustPolicy) {
				policy = next;
			},
		};
	}

	it("signs what a node advertises and reports each node's trust to a reader", async () => {
		const { memory, boardOf } = mesh();
		await boardOf(a.identity).advertise(node("box-a"));
		await boardOf(b.identity).advertise(node("box-b"));
		await boardOf().advertise(node("box-old"));
		// A forged advertisement: box-a's figures changed after it signed.
		const [stored] = (await memory.board.nodes()).filter(
			(each) => each.id === "box-a",
		);
		if (!stored) throw new Error("box-a was not advertised");
		await memory.board.advertise({ ...stored, id: "box-forged" });

		const seen = new Map(
			(await boardOf(a.identity).nodes()).map((each) => [each.id, each.trust]),
		);
		expect(Object.fromEntries(seen)).toEqual({
			"box-a": "trusted",
			"box-b": "unverified",
			"box-old": "unverified",
			"box-forged": "invalid",
		});
	});

	it("does not believe a node that states its own trust", async () => {
		const { memory, boardOf } = mesh();
		await memory.board.advertise(node("liar", { trust: "trusted" }));
		expect((await boardOf(a.identity).nodes())[0]?.trust).toBe("unverified");
	});

	it("follows the trust settings as they change", async () => {
		const { boardOf, setPolicy } = mesh();
		const board = boardOf(a.identity);
		await boardOf(b.identity).advertise(node("box-b"));
		expect((await board.nodes())[0]?.trust).toBe("unverified");
		setPolicy(trusting(a.identity.publicKey, b.identity.publicKey));
		expect((await board.nodes())[0]?.trust).toBe("trusted");
	});

	it("keeps an invalid node out of a coordinator's ranking and reports it once", async () => {
		const { memory, boardOf } = mesh();
		const board = boardOf(a.identity);
		const self = () => node("box-a", { freeSlots: 1 });
		const coordinator = createMeshCoordinator({
			self,
			board,
			claims: memory.claims,
			now: () => NOW,
		});
		await coordinator.advertise();
		// A forgery claiming far more room than box-a has.
		await memory.board.advertise({
			...signMeshAdvert(node("box-big", { freeSlots: 1 }), b.identity),
			freeSlots: 64,
		});
		for (let jobId = 1; jobId <= 200; jobId += 1)
			expect(await coordinator.shouldStart(job(jobId))).toMatchObject({
				start: true,
				rank: 0,
			});

		const events: { event: string; nodeId?: string | number | boolean }[] = [];
		const monitor = createMeshMonitor({
			selfId: "box-a",
			board,
			now: () => NOW,
			log: (event, fields) => events.push({ event, nodeId: fields.nodeId }),
		});
		expect(await monitor.observe()).toMatchObject({ nodes: 1, freeSlots: 1 });
		await monitor.observe();
		expect(
			events.filter((entry) => entry.event === "hobo_ci_mesh_node_invalid"),
		).toEqual([{ event: "hobo_ci_mesh_node_invalid", nodeId: "box-big" }]);
		expect(
			events.some((entry) => entry.event === "hobo_ci_mesh_node_joined"),
		).toBe(false);
	});

	it("ranks only trusted peers once the settings require it", async () => {
		const { memory, boardOf, setPolicy } = mesh();
		let requireTrusted = false;
		const coordinator = createMeshCoordinator({
			self: () => node("box-a", { freeSlots: 1 }),
			board: boardOf(a.identity),
			claims: memory.claims,
			requireTrusted: () => requireTrusted,
			viewMaxAgeMs: 0,
			now: () => NOW,
		});
		// An unlisted peer with far more room is first for most jobs.
		await boardOf(b.identity).advertise(node("box-b", { freeSlots: 40 }));
		const first = async () => {
			let count = 0;
			for (let jobId = 1; jobId <= 200; jobId += 1) {
				const decision = await coordinator.shouldStart(job(jobId * 7919));
				if (decision.rank === 0) count += 1;
			}
			return count;
		};
		expect(await first()).toBeLessThan(40);
		requireTrusted = true;
		setPolicy({ ...trusting(a.identity.publicKey), requireTrusted: true });
		const fresh = createMeshCoordinator({
			self: () => node("box-a", { freeSlots: 1 }),
			board: boardOf(a.identity),
			claims: createMemoryMesh({ now: () => NOW }).claims,
			requireTrusted: () => requireTrusted,
			viewMaxAgeMs: 0,
			now: () => NOW,
		});
		for (let jobId = 1; jobId <= 200; jobId += 1)
			expect(await fresh.shouldStart(job(jobId * 7919))).toMatchObject({
				start: true,
				rank: 0,
			});
	});
});
