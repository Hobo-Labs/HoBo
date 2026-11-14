import { describe, expect, it } from "vitest";
import {
	createDurableLifecycleGate,
	type DurableEventStore,
	type JsonValue,
} from "../src/index.js";
import { isJsonObject, isJsonString } from "../src/json.js";

function fixture() {
	const events: Array<{
		streamId: string;
		seq: number;
		tenant: string;
		type: string;
		data: unknown;
	}> = [];
	const snapshots = new Map<
		string,
		{ streamId: string; seq: number; state: JsonValue; savedAt: string }
	>();
	const store = {
		async *read(streamId: string, fromSeq = 1) {
			for (const event of events)
				if (event.streamId === streamId && event.seq >= fromSeq)
					yield structuredClone(event);
		},
		async commit(request: Parameters<DurableEventStore["commit"]>[0]) {
			const current = events.filter(
				(event) => event.streamId === request.streamId,
			).length;
			if (current !== request.append.expectedSeq)
				throw new Error("sequence conflict");
			for (const [index, event] of request.events.entries()) {
				events.push({
					streamId: request.streamId,
					seq: current + index + 1,
					tenant: request.append.tenant,
					type: event.type,
					data: structuredClone(event.data),
				});
			}
			return {};
		},
		async loadSnapshot(streamId: string) {
			return snapshots.get(streamId);
		},
		async snapshot(streamId: string, state: JsonValue, seq: number) {
			const snapshot = {
				streamId,
				state: structuredClone(state),
				seq,
				savedAt: new Date(1000).toISOString(),
			};
			snapshots.set(streamId, snapshot);
			return snapshot;
		},
	};
	const leases = new Map<string, bigint>();
	let fence = 0n,
		authorized = true,
		drained = true,
		terminated = false,
		now = 1000,
		releaseFailures = 0;
	let onAuthorize: ((action: string) => void) | undefined;
	const actorHost = {
		async acquire(key: string, input: { holderId: string }) {
			if (leases.has(key)) throw new Error("busy");
			const token = ++fence;
			leases.set(key, token);
			return {
				key,
				holderId: input.holderId,
				fenceToken: token,
				expiresAt: new Date(5000).toISOString(),
				async revalidate() {
					if (leases.get(key) !== token) throw new Error("stale lease");
				},
				async release() {
					// A lost release leaves the lease held until it expires.
					if (releaseFailures > 0) {
						releaseFailures--;
						throw new Error("release lost");
					}
					if (leases.get(key) === token) leases.delete(key);
				},
			};
		},
	};
	const protectedStore = {
		...store,
		async commit(request: Parameters<typeof store.commit>[0]) {
			if (leases.get(request.streamId) !== request.append.fenceToken)
				throw new Error("wrong stream fence");
			return store.commit(request);
		},
	};
	const options = {
		scope: {
			tenantId: "tenant",
			app: "ci" as const,
			serviceId: "relay",
			incarnationId: "fleet-1",
		},
		store: protectedStore,
		actorHost,
		actor: { kind: "service" as const, id: "relay" },
		nowMs: () => now,
		authorize: async ({ action }: { action: string }) => {
			if (!authorized) throw new Error("unfunded");
			onAuthorize?.(action);
		},
		verifyDrained: async ({
			scopeDigest,
			fenceId,
		}: {
			scopeDigest: string;
			fenceId: string;
		}) => ({
			scopeDigest,
			fenceId,
			queuesDrained: drained,
			sandboxesDrained: drained,
			evidenceRef: "provider:drained",
			observedAtMs: 1000,
			expiresAtMs: 5000,
		}),
		verifyParticipantTerminated: async () => {
			if (!terminated) throw new Error("termination unknown");
		},
	};
	// SAFETY: this fixture supplies the exact store operations exercised by the
	// gate and enforces a matching actor fence before each in-memory commit.
	const gate = createDurableLifecycleGate(options as never);
	return {
		gate,
		store,
		options,
		setAuthorized: (value: boolean) => {
			authorized = value;
		},
		setDrained: (value: boolean) => {
			drained = value;
		},
		setTerminated: (value: boolean) => {
			terminated = value;
		},
		setNow(value: number) {
			now = value;
		},
		onAuthorize(value: ((action: string) => void) | undefined) {
			onAuthorize = value;
		},
		failNextRelease() {
			releaseFailures++;
		},
		/** Simulates lease expiry at the shared authority. */
		expireLease(key: string) {
			leases.delete(key);
		},
		/** Another holder keeps the lease for `ms` before releasing it. */
		holdLease(key: string, ms: number) {
			if (leases.has(key)) throw new Error("busy");
			const token = ++fence;
			leases.set(key, token);
			return new Promise<void>((resolve) =>
				setTimeout(() => {
					if (leases.get(key) === token) leases.delete(key);
					resolve();
				}, ms),
			);
		},
		close() {},
	};
}
describe("durable application lifecycle gate", () => {
	it("rejects trailing line terminators in scope, operation and evidence identities", async () => {
		const f = fixture();
		try {
			for (const suffix of ["\n", "\r", "\u2028", "\u2029"]) {
				for (const field of [
					"tenantId",
					"serviceId",
					"incarnationId",
				] as const) {
					const scope = {
						...f.options.scope,
						[field]: `${f.options.scope[field]}${suffix}`,
					};
					// SAFETY: the fixture supplies the same fenced store as the valid case;
					// this call tests only the malformed scope identity.
					expect(() =>
						createDurableLifecycleGate({ ...f.options, scope } as never),
					).toThrow();
				}
				await expect(f.gate.initialize(`deploy${suffix}`)).rejects.toThrow();
			}
			await f.gate.initialize("deploy");
			const participant = await f.gate.begin("worker");
			f.setTerminated(true);
			for (const suffix of ["\n", "\r", "\u2028", "\u2029"]) {
				await expect(f.gate.drain(`stop${suffix}`)).rejects.toThrow();
				await expect(
					f.gate.retireParticipant(
						"stop",
						participant.id,
						`provider:termination${suffix}`,
					),
				).rejects.toThrow();
			}
			expect((await f.gate.status()).participants).toHaveLength(1);
			await participant.finish();
		} finally {
			f.close();
		}
	});
	it("rechecks funding and drain proof immediately before committing a transition", async () => {
		const f = fixture();
		try {
			await f.gate.initialize("deploy-1");
			f.onAuthorize((action) => {
				if (action === "drain") f.setAuthorized(false);
			});
			await expect(f.gate.drain("stop-1")).rejects.toThrow(/unfunded/u);
			expect((await f.gate.status()).phase).toBe("open");
			f.setAuthorized(true);
			f.onAuthorize(undefined);
			const fence = await f.gate.drain("stop-1");
			await f.gate.seal("stop-1", fence);
			let checks = 0;
			f.onAuthorize((action) => {
				if (action === "stop" && ++checks === 2) f.setNow(5000);
			});
			await expect(f.gate.stop("stop-1", fence)).rejects.toThrow();
			expect((await f.gate.status()).phase).toBe("sealed");
		} finally {
			f.close();
		}
	});
	it("orders ingress, queue work, sealing and independent drain before stop", async () => {
		const f = fixture();
		try {
			await expect(f.gate.begin("ingress")).rejects.toThrow();
			await f.gate.initialize("deploy-1");
			const ingress = await f.gate.begin("ingress");
			const fenceId = await f.gate.drain("stop-1");
			await expect(f.gate.begin("ingress")).rejects.toThrow();
			await expect(f.gate.begin("producer")).rejects.toThrow();
			const worker = await f.gate.begin("worker");
			expect(await f.gate.seal("stop-1", fenceId)).toBe("waiting");
			await ingress.finish();
			await ingress.finish();
			expect(await f.gate.seal("stop-1", fenceId)).toBe("waiting");
			await worker.finish();
			expect(await f.gate.seal("stop-1", fenceId)).toBe("sealed");
			await expect(f.gate.begin("worker")).rejects.toThrow();
			f.setDrained(false);
			await expect(f.gate.stop("stop-1", fenceId)).rejects.toThrow();
			expect((await f.gate.status()).phase).toBe("sealed");
			await f.gate.resumeDrain("stop-1", fenceId);
			const redelivery = await f.gate.begin("worker");
			await redelivery.finish();
			await f.gate.seal("stop-1", fenceId);
			f.setDrained(true);
			await f.gate.stop("stop-1", fenceId);
			f.setDrained(false);
			await expect(f.gate.stop("stop-1", fenceId)).rejects.toThrow();
			f.setDrained(true);
			f.setAuthorized(false);
			await expect(f.gate.open("start-1", fenceId)).rejects.toThrow();
			f.setAuthorized(true);
			await f.gate.open("start-1", fenceId);
			expect((await f.gate.status()).phase).toBe("open");
		} finally {
			f.close();
		}
	});
	it("keeps a crashed participant until independent termination is verified", async () => {
		const f = fixture();
		try {
			await f.gate.initialize("deploy-1");
			const crashed = await f.gate.begin("worker");
			const fenceId = await f.gate.drain("stop-1");
			await expect(
				f.gate.retireParticipant("stop-1", crashed.id, "provider:termination"),
			).rejects.toThrow();
			expect(await f.gate.seal("stop-1", fenceId)).toBe("waiting");
			f.setTerminated(true);
			await f.gate.retireParticipant(
				"stop-1",
				crashed.id,
				"provider:termination",
			);
			expect(await f.gate.seal("stop-1", fenceId)).toBe("sealed");
		} finally {
			f.close();
		}
	});
	it("serializes concurrent admission with the stop fence", async () => {
		const f = fixture();
		try {
			await f.gate.initialize("deploy-1");
			const results = await Promise.allSettled([
				...Array.from({ length: 20 }, () => f.gate.begin("ingress")),
				f.gate.drain("stop-1"),
			]);
			const last = results.at(-1);
			if (last?.status !== "fulfilled" || !isJsonString(last.value))
				throw new Error("fence did not commit");
			const accepted = results
				.slice(0, -1)
				.filter((result) => result.status === "fulfilled");
			expect((await f.gate.status()).participants).toHaveLength(
				accepted.length,
			);
			await expect(f.gate.begin("ingress")).rejects.toThrow();
			for (const result of accepted)
				if (result.status === "fulfilled" && !isJsonString(result.value))
					await result.value.finish();
			expect(await f.gate.seal("stop-1", last.value)).toBe("sealed");
		} finally {
			f.close();
		}
	});
	it("keeps a committed participant when the lease release fails", async () => {
		const f = fixture();
		try {
			await f.gate.initialize("deploy-1");
			f.failNextRelease();
			const participant = await f.gate.begin("worker");
			expect((await f.gate.status()).participants).toEqual([
				{ id: participant.id, kind: "worker" },
			]);
			f.expireLease(f.gate.streamId);
			const fenceId = await f.gate.drain("stop-1");
			expect(await f.gate.seal("stop-1", fenceId)).toBe("waiting");
			await participant.finish();
			expect(await f.gate.seal("stop-1", fenceId)).toBe("sealed");
		} finally {
			f.close();
		}
	});
	it("finishes a participant while another holder keeps the lease past the default acquire budget", async () => {
		const f = fixture();
		try {
			await f.gate.initialize("deploy-1");
			const participant = await f.gate.begin("ingress");
			const held = f.holdLease(f.gate.streamId, 1500);
			await participant.finish();
			await held;
			expect((await f.gate.status()).participants).toHaveLength(0);
		} finally {
			f.close();
		}
	}, 20_000);
	it("bounds replay with a checkpoint and rejects an overwritten snapshot", async () => {
		const f = fixture();
		try {
			await f.gate.initialize("deploy-1");
			for (let i = 0; i < 64; i++) {
				const participant = await f.gate.begin("ingress");
				await participant.finish();
			}
			const snapshot = await f.store.loadSnapshot?.(f.gate.streamId);
			if (!snapshot?.state || !isJsonObject(snapshot.state))
				throw new Error("fenced checkpoint was not stored");
			expect((await f.gate.status()).participants).toHaveLength(0);
			await f.store.snapshot(
				f.gate.streamId,
				{
					...snapshot.state,
					participants: [],
				},
				snapshot.seq,
			);
			await expect(f.gate.status()).rejects.toThrow(/scope is invalid/u);
		} finally {
			f.close();
		}
	});
});
