import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMemoryMesh,
	createMemoryMeshConfig,
	generateMeshIdentity,
	type MeshNode,
	verifyMeshAdvert,
} from "@hobo/ci/mesh";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	changeMeshTrust,
	createMeshNode,
	createMeshNodesReader,
	createMeshReliabilityLedger,
	createMeshTrust,
	freeDiskMb,
	loadMeshIdentity,
	meshReliabilityJournal,
	meshReliabilityResetToken,
} from "../src/mesh-node.js";
import { meshTrustConfigJson } from "../src/mesh-records.js";
import { createWorkerMesh } from "../src/mesh-worker.js";

const NOW = Date.parse("2026-11-10T03:00:00Z");
const scratch: string[] = [];
const directory = () => {
	const made = mkdtempSync(join(tmpdir(), "hobo-ci-mesh-node-"));
	scratch.push(made);
	return made;
};
afterEach(() => {
	for (const path of scratch.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("a node's identity key", () => {
	it("is made on first start, private to its owner, and the same on every later start", async () => {
		const path = join(directory(), "journal", "mesh-node.key");
		const first = await loadMeshIdentity(path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).toContain("BEGIN PRIVATE KEY");
		const again = await loadMeshIdentity(path);
		expect(again.publicKey).toBe(first.publicKey);
		expect(again.sign("x")).toBe(first.sign("x"));
	});

	it("tightens a key file others could read, and refuses a file that is not a key", async () => {
		const folder = directory();
		const loose = join(folder, "loose.key");
		writeFileSync(loose, generateMeshIdentity().privateKeyPem, { mode: 0o644 });
		await loadMeshIdentity(loose);
		expect(statSync(loose).mode & 0o777).toBe(0o600);
		const garbage = join(folder, "garbage.key");
		writeFileSync(garbage, "not a key");
		await expect(loadMeshIdentity(garbage)).rejects.toThrow();
		// The unreadable file is left alone: it is never overwritten with a new key.
		expect(readFileSync(garbage, "utf8")).toBe("not a key");
	});

	it("loads a private key it cannot change (read-only) without touching it", async () => {
		const folder = directory();
		const path = join(folder, "readonly.key");
		writeFileSync(path, generateMeshIdentity().privateKeyPem, { mode: 0o400 });
		const refused = async () => {
			const error = new Error("read-only file system");
			Object.assign(error, { code: "EROFS" });
			throw error;
		};
		const identity = await loadMeshIdentity(path, { chmod: refused });
		expect(identity.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(statSync(path).mode & 0o777).toBe(0o400);
		// The same for a 0600 key: already private, so left alone.
		const tight = join(folder, "tight.key");
		writeFileSync(tight, generateMeshIdentity().privateKeyPem, { mode: 0o600 });
		await loadMeshIdentity(tight, { chmod: refused });
	});

	it("refuses a key others can read when it cannot be made private", async () => {
		const path = join(directory(), "loose.key");
		writeFileSync(path, generateMeshIdentity().privateKeyPem, { mode: 0o644 });
		await expect(
			loadMeshIdentity(path, {
				chmod: async () => {
					const error = new Error("not permitted");
					Object.assign(error, { code: "EPERM" });
					throw error;
				},
			}),
		).rejects.toThrow(
			/readable by others and could not be made private \(EPERM\)/,
		);
	});

	it("refuses a key in a directory group or others can write", async () => {
		const shared = join(directory(), "shared");
		mkdirSync(shared, { mode: 0o777 });
		chmodSync(shared, 0o777);
		await expect(
			loadMeshIdentity(join(shared, "mesh-node.key")),
		).rejects.toThrow(/writable by group or others/);
		expect(existsSync(join(shared, "mesh-node.key"))).toBe(false);
	});

	it("gives two nodes two identities", async () => {
		const folder = directory();
		const a = await loadMeshIdentity(join(folder, "a.key"));
		const b = await loadMeshIdentity(join(folder, "b.key"));
		expect(a.publicKey).not.toBe(b.publicKey);
	});
});

describe("measured disk", () => {
	it("reports the free megabytes of the filesystem holding a directory", () => {
		const measured = freeDiskMb(directory());
		expect(measured).toBeTypeOf("number");
		expect(Number.isSafeInteger(measured)).toBe(true);
		expect(measured).toBeGreaterThan(0);
	});

	it("reports nothing, not zero, when the filesystem cannot be asked", () => {
		expect(
			freeDiskMb(join(directory(), "does", "not", "exist")),
		).toBeUndefined();
	});
});

describe("a worker's reliability across a restart", () => {
	const settings = {
		servers: ["nats://127.0.0.1:4222"],
		nodeId: "box-a",
		namespace: "hobo-ci",
		replicas: 1,
		stepMs: 20_000,
		reliabilityHalfLifeMs: 30 * 60_000,
	};
	const queued = (jobId: number) => ({
		jobId,
		runId: 900,
		label: "hobo",
		createdAt: "2026-11-10T02:59:00Z",
	});

	/** One life of the worker: open its journal, take jobs, close the journal. */
	async function life(
		path: string,
		clock: { now: number },
		run: (mesh: ReturnType<typeof createWorkerMesh>) => Promise<void>,
		options: { resetToken?: string } = {},
	) {
		const journal = new SqliteCiStore(path);
		try {
			const stored = meshReliabilityJournal(
				journal,
				settings.nodeId,
				undefined,
				options.resetToken,
			);
			const loaded = await stored.load(clock.now);
			const ports = createMemoryMesh({ now: () => clock.now });
			const writes: Promise<void>[] = [];
			const mesh = createWorkerMesh({
				settings,
				board: ports.board,
				claims: ports.claims,
				freeSlots: () => 4,
				totalSlots: 4,
				healthy: () => true,
				servesTrunk: false,
				free: () => ({ memoryMb: 8_192, diskMb: freeDiskMb(tmpdir()) }),
				initialReliability: loaded.record,
				persistReliability: (record) => {
					writes.push(stored.save(record));
				},
				now: () => clock.now,
			});
			await run(mesh);
			await Promise.all(writes);
			await mesh.advertise();
			const [self] = await ports.board.nodes();
			return {
				reliability: mesh.reliability(),
				samples: mesh.samples(),
				advertised: self,
				reset: loaded.reset,
			};
		} finally {
			journal.close();
		}
	}

	it("keeps the record of dropped jobs in the journal, and decays it for the time it was down", async () => {
		const path = join(directory(), "journal.sqlite");
		const clock = { now: NOW };
		const before = await life(path, clock, async (mesh) => {
			for (let jobId = 1; jobId <= 10; jobId += 1) {
				await mesh.claim(queued(jobId));
				mesh.record("hobo_ci_launch_parked", { jobId });
			}
			await mesh.claim(queued(11));
			mesh.record("hobo_ci_job_pickup", { jobId: 11 });
		});
		// Ten dropped and one delivered behind four imaginary deliveries: 5 of 15.
		expect(before.reliability).toBeCloseTo(5 / 15, 5);
		expect(before.samples).toEqual({ delivered: 1, dropped: 10 });

		// The process ends; nothing is left in memory. A new one starts at once.
		const restarted = await life(path, clock, async () => undefined);
		expect(restarted.reliability).toBeCloseTo(before.reliability, 10);
		expect(restarted.samples).toEqual(before.samples);
		expect(restarted.advertised).toMatchObject({
			reliability: restarted.reliability,
			samples: { delivered: 1, dropped: 10 },
		});

		// Down for one half-life: every past job counts for half as much.
		clock.now += 30 * 60_000;
		const later = await life(path, clock, async () => undefined);
		expect(later.samples).toEqual({ delivered: 0.5, dropped: 5 });
		expect(later.reliability).toBeCloseTo(4.5 / 9.5, 5);
		expect(later.reliability).toBeGreaterThan(before.reliability);
	});

	it("starts clean without a journal record, and when the operator resets it", async () => {
		const path = join(directory(), "journal.sqlite");
		const clock = { now: NOW };
		expect((await life(path, clock, async () => undefined)).reliability).toBe(
			1,
		);
		await life(path, clock, async (mesh) => {
			await mesh.claim(queued(1));
			mesh.record("hobo_ci_container_oom", { jobId: 1 });
		});
		expect(
			(await life(path, clock, async () => undefined)).reliability,
		).toBeLessThan(1);
		const reset = await life(path, clock, async () => undefined, {
			resetToken: "1",
		});
		expect([reset.reliability, reset.reset]).toEqual([1, true]);
	});

	it("applies a reset once per token, so a variable left set does not clear every restart", async () => {
		const path = join(directory(), "journal.sqlite");
		const clock = { now: NOW };
		const drop = async (
			mesh: ReturnType<typeof createWorkerMesh>,
			jobId: number,
		) => {
			await mesh.claim(queued(jobId));
			mesh.record("hobo_ci_launch_parked", { jobId });
		};
		await life(path, clock, (mesh) => drop(mesh, 1));
		const first = await life(path, clock, (mesh) => drop(mesh, 2), {
			resetToken: "1",
		});
		// Cleared at start; the drop after the reset is kept.
		expect(first.reset).toBe(true);
		expect(first.samples).toEqual({ delivered: 0, dropped: 1 });
		// HOBO_CI_MESH_RELIABILITY_RESET=1 is still set at the next start.
		const again = await life(path, clock, async () => undefined, {
			resetToken: "1",
		});
		expect(again.reset).toBe(false);
		expect(again.samples).toEqual({ delivered: 0, dropped: 1 });
		// A new token resets once more.
		const fresh = await life(path, clock, async () => undefined, {
			resetToken: "2026-11-11",
		});
		expect([fresh.reset, fresh.reliability]).toEqual([true, 1]);
	});

	it("reads the reset variable: off for unset or 0, a token otherwise", () => {
		expect(meshReliabilityResetToken(undefined)).toBeUndefined();
		expect(meshReliabilityResetToken("")).toBeUndefined();
		expect(meshReliabilityResetToken("0")).toBeUndefined();
		expect(meshReliabilityResetToken("1")).toBe("1");
		expect(meshReliabilityResetToken("2026-11-11")).toBe("2026-11-11");
		expect(() => meshReliabilityResetToken("not a token!")).toThrow(
			"HOBO_CI_MESH_RELIABILITY_RESET",
		);
	});

	it("advertises measured free disk beside free memory", async () => {
		const path = join(directory(), "journal.sqlite");
		const { advertised } = await life(
			path,
			{ now: NOW },
			async () => undefined,
		);
		expect(advertised?.free?.memoryMb).toBe(8_192);
		expect(advertised?.free?.diskMb).toBeGreaterThan(0);
	});

	it("carries on in memory when the journal cannot be read or written", async () => {
		const failures: string[] = [];
		const broken = meshReliabilityJournal(
			{
				controlRecord: () => {
					throw new Error("disk gone");
				},
				putControlRecord: () => {
					throw new Error("disk full");
				},
			},
			"box-a",
			(message) => failures.push(message),
		);
		expect(await broken.load()).toEqual({ record: undefined, reset: false });
		await broken.save({ delivered: 1, dropped: 0, atMs: NOW });
		expect(failures).toEqual(["disk gone", "disk full"]);
		// A record that is not one reads as no record.
		const garbled = meshReliabilityJournal(
			{
				controlRecord: () => ({ bodyJson: '{"delivered":"many"}' }),
				putControlRecord: () => undefined,
			},
			"box-a",
		);
		expect((await garbled.load()).record).toBeUndefined();
	});

	it("counts a simple node's sessions the same way", () => {
		const saved: number[] = [];
		const ledger = createMeshReliabilityLedger({
			persist: (record) => saved.push(record.dropped),
			now: () => NOW,
		});
		expect(ledger.score()).toBe(1);
		ledger.count("delivered");
		ledger.count("dropped");
		expect(ledger.samples()).toEqual({ delivered: 1, dropped: 1 });
		expect(ledger.score()).toBeCloseTo(5 / 6, 10);
		expect(saved).toEqual([0, 1]);
	});
});

describe("the trust settings a node works by", () => {
	const self = generateMeshIdentity().identity.publicKey;
	const other = generateMeshIdentity().identity.publicKey;

	it("trusts only itself until the mesh lists keys, then goes by the list", async () => {
		const store = createMemoryMeshConfig();
		const events: string[] = [];
		const trust = createMeshTrust({
			store,
			selfPublicKey: self,
			log: (event) => events.push(event),
		});
		await trust.refresh();
		expect(trust.policy()).toEqual({
			trustedKeys: [{ publicKey: self }],
			requireTrusted: false,
		});
		// Nothing stored is the default, not a change worth an event.
		expect(events).toEqual([]);

		const listed = {
			trustedKeys: [{ publicKey: other, nodeId: "box-b" }],
			requireTrusted: true,
		};
		await store.publish(meshTrustConfigJson(listed));
		await trust.refresh();
		expect(trust.policy()).toEqual(listed);
		expect(trust.requireTrusted()).toBe(true);
		await trust.refresh();
		expect(events).toEqual(["hobo_ci_mesh_trust_changed"]);
	});

	it("keeps the last good settings when the store is unreadable or unreachable", async () => {
		let stored: { value: string; revision: number } | undefined;
		let down = false;
		const events: string[] = [];
		const trust = createMeshTrust({
			store: {
				read: async () => {
					if (down) throw new Error("NATS not connected");
					return stored;
				},
				publish: async () => "conflict",
			},
			selfPublicKey: self,
			log: (event) => events.push(event),
		});
		const listed = {
			trustedKeys: [{ publicKey: other }],
			requireTrusted: true,
		};
		stored = { value: meshTrustConfigJson(listed), revision: 1 };
		await trust.refresh();
		stored = {
			value: '{"trustedKeys":[{"publicKey":"garbage"}]}',
			revision: 2,
		};
		await trust.refresh();
		await trust.refresh();
		expect(trust.policy()).toEqual(listed);
		expect(events).toEqual([
			"hobo_ci_mesh_trust_changed",
			"hobo_ci_mesh_trust_unreadable",
		]);
		down = true;
		await trust.refresh();
		expect(trust.policy()).toEqual(listed);
	});

	it("lets an operator list, bind, unlist and require keys, one revision at a time", async () => {
		const store = createMemoryMeshConfig();
		expect(
			await changeMeshTrust(store, {
				kind: "add",
				publicKey: self,
				anyNode: true,
			}),
		).toEqual({
			trustedKeys: [{ publicKey: self }],
			requireTrusted: false,
		});
		await changeMeshTrust(store, {
			kind: "add",
			publicKey: other,
			nodeId: "box-b",
		});
		// Listing a key again replaces its entry: here, it gains a binding.
		await changeMeshTrust(store, {
			kind: "add",
			publicKey: self,
			nodeId: "box-a",
		});
		expect(
			await changeMeshTrust(store, { kind: "require", requireTrusted: true }),
		).toEqual({
			trustedKeys: [
				{ publicKey: other, nodeId: "box-b" },
				{ publicKey: self, nodeId: "box-a" },
			],
			requireTrusted: true,
		});
		expect(
			await changeMeshTrust(store, { kind: "remove", publicKey: other }),
		).toEqual({
			trustedKeys: [{ publicKey: self, nodeId: "box-a" }],
			requireTrusted: true,
		});
		expect((await store.read())?.revision).toBe(5);
		// What a node then works by.
		const trust = createMeshTrust({ store, selfPublicKey: other });
		await trust.refresh();
		expect(trust.policy()).toEqual({
			trustedKeys: [{ publicKey: self, nodeId: "box-a" }],
			requireTrusted: true,
		});
	});

	it("reapplies an edit when another operator wrote first, and never overwrites what it cannot read", async () => {
		const store = createMemoryMeshConfig();
		await changeMeshTrust(store, {
			kind: "add",
			publicKey: self,
			anyNode: true,
		});
		let raced = false;
		const racing = {
			read: () => store.read(),
			publish: async (value: string, expectedRevision?: number) => {
				if (!raced) {
					raced = true;
					// Someone else requires trust between this edit's read and write.
					await changeMeshTrust(store, {
						kind: "require",
						requireTrusted: true,
					});
				}
				return store.publish(value, expectedRevision);
			},
		};
		expect(
			await changeMeshTrust(racing, {
				kind: "add",
				publicKey: other,
				anyNode: true,
			}),
		).toEqual({
			trustedKeys: [{ publicKey: self }, { publicKey: other }],
			// The other operator's change survived.
			requireTrusted: true,
		});

		const garbled = createMemoryMeshConfig();
		await garbled.publish('{"trustedKeys":[{"publicKey":"garbage"}]}');
		await expect(
			changeMeshTrust(garbled, { kind: "add", publicKey: self, anyNode: true }),
		).rejects.toThrow("cannot be read");
		expect((await garbled.read())?.revision).toBe(1);
		await expect(
			changeMeshTrust(store, {
				kind: "add",
				publicKey: "too-short",
				nodeId: "box-a",
			}),
		).rejects.toThrow("invalid mesh public key");
	});

	it("refuses to trust a key under any node id unless that is asked for explicitly", async () => {
		const store = createMemoryMeshConfig();
		await expect(
			changeMeshTrust(store, { kind: "add", publicKey: self }),
		).rejects.toThrow("--any-node");
		expect(await store.read()).toBeUndefined();
	});

	it("fails closed when settings are stored and it has never read them", async () => {
		const store = createMemoryMeshConfig();
		await store.publish("{ not trust settings");
		const events: { event: string; failedClosed?: unknown }[] = [];
		const trust = createMeshTrust({
			store,
			selfPublicKey: self,
			log: (event, fields) =>
				events.push({ event, failedClosed: fields.failedClosed }),
		});
		await trust.refresh();
		expect(trust.policy()).toEqual({
			trustedKeys: [{ publicKey: self }],
			requireTrusted: true,
		});
		expect(events).toEqual([
			{ event: "hobo_ci_mesh_trust_unreadable", failedClosed: true },
		]);
		// Settings it can read lift it.
		const listed = {
			trustedKeys: [{ publicKey: other }],
			requireTrusted: false,
		};
		await store.publish(meshTrustConfigJson(listed), 1);
		await trust.refresh();
		expect(trust.policy()).toEqual(listed);
	});

	it("reads settings with a field a newer version added", async () => {
		const store = createMemoryMeshConfig();
		await store.publish(
			`{"trustedKeys":[{"publicKey":"${other}","nodeId":"box-b","note":"rack 3"}],"requireTrusted":true,"rotateBy":"2027-01-01"}`,
		);
		const trust = createMeshTrust({ store, selfPublicKey: self });
		await trust.refresh();
		expect(trust.policy()).toEqual({
			trustedKeys: [{ publicKey: other, nodeId: "box-b" }],
			requireTrusted: true,
		});
	});

	it("trusts only its own key when it has no mesh at all", async () => {
		const trust = createMeshTrust({ selfPublicKey: self });
		await trust.refresh();
		expect(trust.policy().trustedKeys).toEqual([{ publicKey: self }]);
	});
});

describe("asking what the mesh looks like", () => {
	const node = (id: string, overrides: Partial<MeshNode> = {}): MeshNode => ({
		id,
		freeSlots: 2,
		totalSlots: 4,
		healthy: true,
		labels: ["hobo"],
		validUntilMs: NOW + 45_000,
		...overrides,
	});

	it("answers not-configured on a host with no mesh: an answer, not an error", async () => {
		const answer = await createMeshNodesReader()();
		expect(answer.mesh).toBe("not-configured");
		expect(answer.nodes).toEqual([]);
		expect(answer.capacity).toBeUndefined();
	});

	it("lists the board's nodes, then keeps one that stops advertising as lost", async () => {
		const clock = { now: NOW };
		const memory = createMemoryMesh({ now: () => clock.now });
		const read = createMeshNodesReader({
			board: memory.board,
			now: () => clock.now,
		});
		await memory.board.advertise(node("a"));
		await memory.board.advertise(node("b", { freeSlots: 1 }));
		const first = await read();
		expect(first.mesh).toBe("configured");
		expect(first.nodes.map((each) => [each.id, each.state])).toEqual([
			["a", "live"],
			["b", "live"],
		]);
		expect(first.capacity).toMatchObject({ nodes: 2, freeSlots: 3 });

		clock.now += 46_000;
		await memory.board.advertise(
			node("a", { validUntilMs: clock.now + 45_000 }),
		);
		const later = await read();
		expect(later.nodes.map((each) => [each.id, each.state])).toEqual([
			["a", "live"],
			["b", "lost"],
		]);
		expect(later.capacity).toMatchObject({ nodes: 1, freeSlots: 2 });
	});

	it("answers unreachable with its last reading when the board cannot be read", async () => {
		const memory = createMemoryMesh({ now: () => NOW });
		let down = false;
		const read = createMeshNodesReader({
			board: {
				nodes: async () => {
					if (down) throw new Error("NATS not connected");
					return memory.board.nodes();
				},
			},
			now: () => NOW,
		});
		await memory.board.advertise(node("a"));
		expect((await read()).mesh).toBe("configured");
		down = true;
		const answer = await read();
		expect(answer.mesh).toBe("unreachable");
		expect(answer.nodes.map((each) => each.id)).toEqual(["a"]);
	});
});

describe("a node that takes no jobs through the mesh", () => {
	const describeNode = () => ({
		freeSlots: 0,
		totalSlots: 0,
		healthy: true,
		labels: [],
		platform: { os: "linux", arch: "x64" },
	});

	it("reports itself, trusted by itself, with no mesh configured", async () => {
		const { identity } = generateMeshIdentity();
		const offline = createMeshNode({
			nodeId: "relay-a",
			identity,
			describe: describeNode,
			now: () => NOW,
		});
		await offline.beat();
		expect(offline.board).toBeUndefined();
		const answer = await offline.reports();
		expect(answer.mesh).toBe("not-configured");
		expect(answer.nodes).toHaveLength(1);
		expect(answer.nodes[0]).toMatchObject({
			id: "relay-a",
			state: "live",
			trust: "trusted",
			totalSlots: 0,
			freeSlots: 0,
		});
		expect(answer.readAt).toBe("2026-11-10T03:00:00.000Z");
	});

	it("signs what it advertises, and lists its peers by how far it trusts them", async () => {
		const clock = { now: NOW };
		const memory = createMemoryMesh({ now: () => clock.now });
		const trustStore = createMemoryMeshConfig();
		const mesh = { board: memory.board, trust: trustStore };
		const relayKey = generateMeshIdentity().identity;
		const boxKey = generateMeshIdentity().identity;
		const events: string[] = [];
		let healthy = true;
		const relay = createMeshNode({
			nodeId: "relay-a",
			identity: relayKey,
			mesh,
			describe: () => ({ ...describeNode(), healthy }),
			now: () => clock.now,
			log: (event) => events.push(event),
		});
		const box = createMeshNode({
			nodeId: "box-a",
			identity: boxKey,
			mesh,
			describe: () => ({
				freeSlots: 2,
				totalSlots: 4,
				healthy: true,
				labels: ["hobo"],
			}),
			now: () => clock.now,
		});
		await relay.beat();
		await box.beat();

		// On the shared board every advertisement is signed, with no private key.
		const stored = await memory.board.nodes();
		expect(stored.map((each) => verifyMeshAdvert(each))).toEqual([
			"valid",
			"valid",
		]);
		expect(stored.find((each) => each.id === "relay-a")).toMatchObject({
			freeSlots: 0,
			totalSlots: 0,
			labels: [],
			identity: { publicKey: relayKey.publicKey },
		});

		// No keys listed: each trusts only itself.
		const alone = await relay.reports();
		expect(alone.nodes.map((each) => [each.id, each.trust])).toEqual([
			["box-a", "unverified"],
			["relay-a", "trusted"],
		]);
		// The operator lists the box's key; the relay's own drops off the list.
		await trustStore.publish(
			meshTrustConfigJson({
				trustedKeys: [{ publicKey: boxKey.publicKey, nodeId: "box-a" }],
				requireTrusted: false,
			}),
		);
		await relay.beat();
		expect(
			(await relay.reports()).nodes.map((each) => [each.id, each.trust]),
		).toEqual([
			["box-a", "trusted"],
			["relay-a", "unverified"],
		]);

		// The relay turns unhealthy: it says so, and since when.
		clock.now += 10_000;
		healthy = false;
		await relay.beat();
		const draining = (await box.reports()).nodes.find(
			(each) => each.id === "relay-a",
		);
		expect(draining).toMatchObject({
			state: "unhealthy",
			since: new Date(clock.now).toISOString(),
		});
		expect(events).toContain("hobo_ci_mesh_trust_changed");
	});

	it("carries on, and says so once, while the board cannot be reached", async () => {
		const events: string[] = [];
		const offline = createMeshNode({
			nodeId: "relay-a",
			identity: generateMeshIdentity().identity,
			mesh: {
				board: {
					advertise: async () => {
						throw new Error("NATS not connected");
					},
					nodes: async () => {
						throw new Error("NATS not connected");
					},
				},
				trust: createMemoryMeshConfig(),
			},
			describe: describeNode,
			now: () => NOW,
			log: (event) => events.push(event),
		});
		await offline.beat();
		await offline.beat();
		expect(events).toEqual(["hobo_ci_mesh_board_unreachable"]);
		const answer = await offline.reports();
		expect(answer.mesh).toBe("unreachable");
		expect(answer.nodes.map((each) => each.id)).toEqual(["relay-a"]);
	});
});
