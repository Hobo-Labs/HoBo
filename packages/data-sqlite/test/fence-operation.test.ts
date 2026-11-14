import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalFenceOperationReceipt,
	encodeRecordKey,
	type FenceOperationClaim,
	parseCanonicalRecord,
	parseDatasetSchema,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import { describe, expect, it } from "vitest";
import { createSqliteEngine } from "../src/index.js";

const schema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [{ name: "id", type: "string" }],
});
const key = generateKeyPairSync("ed25519"),
	wrong = generateKeyPairSync("ed25519");
const receivers = new Map([["router", key.publicKey]]);
const digest = `sha256:${"a".repeat(64)}`;
function receipt(claim: FenceOperationClaim, signer = key.privateKey) {
	const body = {
		...claim,
		contract: "hobo.fence-operation-receipt/v1" as const,
		outcome: "committed" as const,
	};
	return {
		...body,
		signature: sign(
			null,
			Buffer.from(canonicalFenceOperationReceipt(body)),
			signer,
		).toString("base64url"),
	};
}

describe("SQLite native fence operation", () => {
	it("holds source writes, release, retirement and capture until the exact receiver receipt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-fence-operation-")),
			path = join(dir, "source.db");
		const a = createSqliteEngine({ path, operationReceivers: receivers });
		const b = createSqliteEngine({ path, operationReceivers: receivers });
		try {
			expect(a.schema).toBeUndefined();
			await a.datasets.ensureDataset(schema);
			const scope = scopeOf("orders"),
				subscription = "migration-sub";
			const position = await a.capture?.start({ scope, subscription });
			if (
				position === undefined ||
				!a.fence ||
				!b.fence ||
				!a.fence.operation ||
				!b.fence.operation
			)
				throw new Error("missing fence fixture");
			const grant = await a.fence.raise({ scope, reason: "cutover" });
			const request = {
				scope,
				fenceToken: grant.fenceToken,
				operationId: "operation-one",
				routeDigest: digest,
				receiverKeyId: "router",
			};
			const claim = await a.fence.operation.claim(request);
			expect(await b.fence.operation.claim(request)).toEqual(claim);
			await expect(
				Promise.resolve().then(() =>
					b.fence?.release({ scope, fenceToken: grant.fenceToken }),
				),
			).rejects.toThrow(/operation is still held/u);
			await expect(
				Promise.resolve().then(() =>
					b.fence?.operation?.claim({ ...request, operationId: "other" }),
				),
			).rejects.toThrow(/operation is still held/u);
			const record = parseCanonicalRecord(schema, { id: "1" });
			await expect(
				Promise.resolve().then(() =>
					a.records.write({
						dataset: "orders",
						fenceToken: grant.fenceToken,
						mutations: [
							upsertMutation("", encodeRecordKey(schema, record), record),
						],
					}),
				),
			).rejects.toThrow(/operation is still held/u);
			await expect(
				Promise.resolve().then(() => a.capture?.stop(subscription)),
			).rejects.toThrow(/operation is still held/u);
			await expect(
				Promise.resolve().then(() =>
					a.capture?.acknowledge({ subscription, position }),
				),
			).rejects.toThrow(/operation is still held/u);
			await expect(
				Promise.resolve().then(() =>
					a.apply?.apply({
						dataset: "orders",
						source: "old",
						position,
						changes: [],
					}),
				),
			).rejects.toThrow(/operation is still held/u);
			const current = await a.verify?.digest({ scope, buckets: 1 });
			if (!current) throw new Error("missing digest");
			await expect(
				Promise.resolve().then(() =>
					a.retire?.retire({
						scope,
						fenceToken: grant.fenceToken,
						expected: current,
					}),
				),
			).rejects.toThrow(/operation is still held/u);
			await expect(
				Promise.resolve().then(() =>
					a.fence?.operation?.complete(receipt(claim, wrong.privateKey)),
				),
			).rejects.toThrow(/untrusted/u);
			const signed = receipt(claim);
			const noncanonical = `${signed.signature.slice(0, -1)}${String.fromCharCode(signed.signature.charCodeAt(signed.signature.length - 1) + 1)}`;
			expect(Buffer.from(noncanonical, "base64url")).toEqual(
				Buffer.from(signed.signature, "base64url"),
			);
			await expect(
				Promise.resolve().then(() =>
					a.fence?.operation?.complete({ ...signed, signature: noncanonical }),
				),
			).rejects.toThrow(/untrusted/u);
			const unsignedExtra = { ...signed, untrusted: true };
			await expect(
				Promise.resolve().then(() =>
					a.fence?.operation?.complete(unsignedExtra),
				),
			).rejects.toThrow(/invalid native fence operation receipt/u);
			const altered = { ...claim, routeDigest: `sha256:${"b".repeat(64)}` };
			await expect(
				Promise.resolve().then(() =>
					a.fence?.operation?.complete(receipt(altered)),
				),
			).rejects.toThrow(/foreign scope/u);
			expect(await a.fence.operation.inspect(scope)).toMatchObject({
				status: "held",
				claim,
			});
			await a.fence.operation.complete(receipt(claim));
			await a.fence.operation.complete(receipt(claim));
			expect(await a.fence.operation.inspect(scope)).toBeUndefined();
			expect(await a.fence.operation.inspect(scope, claim.operationId)).toEqual(
				{ status: "completed", claim },
			);
			await a.fence.release({ scope, fenceToken: grant.fenceToken });
			const later = await a.fence.raise({ scope, reason: "next" });
			await expect(
				Promise.resolve().then(() =>
					a.fence?.operation?.claim({
						...request,
						fenceToken: later.fenceToken,
					}),
				),
			).rejects.toThrow(/already used/u);
		} finally {
			await a.close();
			await b.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retains an uncertain lock across restart and refuses unenrolled keys", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-fence-recovery-")),
			path = join(dir, "source.db");
		let engine = createSqliteEngine({ path, operationReceivers: receivers });
		try {
			await engine.datasets.ensureDataset(schema);
			const scope = scopeOf("orders");
			if (!engine.fence?.operation) throw new Error("missing operation port");
			const grant = await engine.fence.raise({ scope, reason: "cutover" });
			const claim = await engine.fence.operation.claim({
				scope,
				fenceToken: grant.fenceToken,
				operationId: "pending",
				routeDigest: digest,
				receiverKeyId: "router",
			});
			await engine.close();
			engine = createSqliteEngine({ path });
			expect(engine.schema).toBeUndefined();
			expect(engine.fence?.operation).toBeUndefined();
			await expect(
				Promise.resolve().then(() =>
					engine.fence?.release({ scope, fenceToken: grant.fenceToken }),
				),
			).rejects.toThrow(/operation is still held/u);
			await engine.close();
			expect(() =>
				createSqliteEngine({
					path,
					operationReceivers: new Map([["router", wrong.publicKey]]),
				}),
			).toThrow(/policy differs/u);
			engine = createSqliteEngine({ path, operationReceivers: receivers });
			expect(await engine.fence?.operation?.inspect(scope)).toMatchObject({
				status: "held",
				claim,
			});
			await engine.fence?.operation?.complete(receipt(claim));
			await engine.fence?.release({ scope, fenceToken: grant.fenceToken });
		} finally {
			await engine.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

it("serializes a native fence release against operation claims from another process", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-fence-race-")),
		path = join(dir, "source.db");
	const engine = createSqliteEngine({ path, operationReceivers: receivers });
	const { Worker } = await import("node:worker_threads"),
		{ once } = await import("node:events");
	const worker = new Worker(
		`
		const { parentPort, workerData } = require('node:worker_threads');
		(async () => {
			const { createSqliteEngine } = await import(workerData.entry);
			const engine = createSqliteEngine({ path: workerData.path, operationReceivers: new Map([['router', workerData.publicKey]]) });
			parentPort.on('message', async message => {
				if (message.stop) { await engine.close(); parentPort.close(); return; }
				try { await engine.fence.release({ scope: message.scope, fenceToken: message.token }); parentPort.postMessage({ released: true }); }
				catch { parentPort.postMessage({ released: false }); }
			});
			parentPort.postMessage({ ready: true });
		})().catch(error => { parentPort.postMessage({ error: String(error) }); });
	`,
		{
			eval: true,
			workerData: {
				path,
				entry: new URL("../dist/index.js", import.meta.url).href,
				publicKey: key.publicKey.export({ type: "spki", format: "pem" }),
			},
		},
	);
	try {
		await engine.datasets.ensureDataset(schema);
		const [ready] = await once(worker, "message");
		expect(ready).toEqual({ ready: true });
		if (!engine.fence?.operation) throw new Error("missing operation port");
		for (let i = 0; i < 8; i++) {
			const scope = scopeOf("orders", `tenant-${i}`);
			const grant = await engine.fence.raise({ scope, reason: "cutover" });
			const reply = once(worker, "message");
			worker.postMessage({ scope, token: grant.fenceToken });
			let claim: FenceOperationClaim | undefined;
			try {
				claim = await engine.fence.operation.claim({
					scope,
					fenceToken: grant.fenceToken,
					operationId: `race-${i}`,
					routeDigest: digest,
					receiverKeyId: "router",
				});
			} catch {
				/* the concurrent release may win */
			}
			const [message] = await reply;
			expect(Boolean(claim) && message.released === true).toBe(false);
			if (claim) {
				await engine.fence.operation.complete(receipt(claim));
				await engine.fence.release({ scope, fenceToken: grant.fenceToken });
			} else if (!message.released) {
				await engine.fence.release({ scope, fenceToken: grant.fenceToken });
			}
		}
	} finally {
		worker.postMessage({ stop: true });
		await worker.terminate();
		await engine.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 45_000);
