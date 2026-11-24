import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RawAccess } from "rivetkit/db";
import { afterEach, expect, it } from "vitest";
import {
	kvFingerprint,
	RIVET_ASYNC_KV_CAPABILITIES,
	type RivetAsyncKvOperation,
} from "../src/rivet-kv-protocol.js";
import {
	createRivetAsyncKvActor,
	isRivetAsyncKvBinding,
	migrateRivetAsyncKv,
} from "../src/rivet-kv-runtime.js";

const digest = `sha256:${"a".repeat(64)}`;
const opened: DatabaseSync[] = [];
afterEach(() => {
	for (const database of opened.splice(0)) database.close();
});

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	opened.push(sqlite);
	let tail = Promise.resolve();
	const execute = async (query: string, ...args: SQLInputValue[]) =>
		sqlite.prepare(query).all(...args);
	const transaction = async <T>(run: (tx: RawAccess) => Promise<T>) => {
		const before = tail;
		let release = () => {};
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await before;
		let begun = false;
		try {
			sqlite.exec("BEGIN IMMEDIATE");
			begun = true;
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture provides the transaction execute operation used by the actor.
			const result = await run({ execute } as RawAccess);
			sqlite.exec("COMMIT");
			begun = false;
			return result;
		} catch (error) {
			if (begun) sqlite.exec("ROLLBACK");
			throw error;
		} finally {
			release();
		}
	};
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the actor uses these two SQLite methods in this fixture.
	const db = { execute, transaction } as RawAccess;
	await migrateRivetAsyncKv(db);
	let deniedPhase: "operation" | "delivery" | undefined;
	const phases: string[] = [];
	const binding = createRivetAsyncKvActor({
		actorName: "store",
		semanticDigest: digest,
		verifyIngress: () => true,
		authorize: (claim) => {
			phases.push(claim.phase);
			return claim.phase !== deniedPhase;
		},
	});
	const send = async (
		operation: RivetAsyncKvOperation,
		key: string,
		bytes?: Uint8Array,
		corruptFingerprint = false,
	) => {
		const requestId = randomUUID();
		const value =
			bytes === undefined ? undefined : Buffer.from(bytes).toString("base64");
		const fingerprint = kvFingerprint(digest, operation, requestId, key, value);
		const body =
			value === undefined ? { requestId, key } : { requestId, key, value };
		const response = await binding.handle(
			{ name: "store", key: ["tenant", "instance", "epoch-1"], db },
			new Request(`https://actor.test/${operation}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-hobo-kv-request-id": requestId,
					"x-hobo-kv-semantic-digest": digest,
					"x-hobo-kv-fingerprint": corruptFingerprint
						? `sha256:${"0".repeat(64)}`
						: fingerprint,
				},
				body: JSON.stringify(body),
			}),
		);
		return { status: response.status, body: await response.json() };
	};
	return {
		binding,
		phases,
		send,
		sqlite,
		deny: (phase: "operation" | "delivery") => {
			deniedPhase = phase;
		},
	};
}

it("preserves exact bytes and distinguishes missing, empty and deleted keys", async () => {
	const f = await fixture();
	expect(isRivetAsyncKvBinding(f.binding)).toBe(true);
	expect(isRivetAsyncKvBinding({ ...f.binding })).toBe(false);
	expect(f.binding.capabilities).toEqual(RIVET_ASYNC_KV_CAPABILITIES);
	expect(f.binding.capabilities).toMatchObject({
		synchronousWit: false,
		bindleDependencies: false,
		durableIdempotency: false,
		singleDispatchRequired: true,
	});
	expect((await f.send("get", "orders")).body).toMatchObject({ value: null });
	expect((await f.send("set", "orders", new Uint8Array([0, 255]))).status).toBe(
		200,
	);
	expect((await f.send("get", "orders")).body).toMatchObject({ value: "AP8=" });
	expect((await f.send("set", "orders", new Uint8Array())).status).toBe(200);
	expect((await f.send("get", "orders")).body).toMatchObject({ value: "" });
	expect((await f.send("exists", "orders")).body).toMatchObject({
		exists: true,
	});
	expect((await f.send("delete", "orders")).status).toBe(200);
	expect((await f.send("exists", "orders")).body).toMatchObject({
		exists: false,
	});
	expect(f.phases).toEqual(
		Array(8).fill(["access", "operation", "delivery"]).flat(),
	);
});

it("rejects a bad fingerprint or an operation denial before changing storage", async () => {
	const f = await fixture();
	expect((await f.send("set", "key", new Uint8Array([1]), true)).status).toBe(
		400,
	);
	f.deny("operation");
	expect((await f.send("set", "key", new Uint8Array([2]))).status).toBe(403);
	expect(
		f.sqlite.prepare("SELECT COUNT(*) AS n FROM hobo_kv_entries").get(),
	).toMatchObject({ n: 0 });
});

it("reports unknown after a committed write loses delivery authorization", async () => {
	const f = await fixture();
	f.deny("delivery");
	const result = await f.send("set", "key", new Uint8Array([5]));
	expect(result.status).toBe(503);
	expect(result.body).toMatchObject({
		error: "outcome-unknown",
		operation: "set",
	});
	expect(
		f.sqlite
			.prepare("SELECT value FROM hobo_kv_entries WHERE key=?")
			.get("key"),
	).toMatchObject({ value: "BQ==" });
});

it("refuses a mutation if stored accounting is inconsistent", async () => {
	const f = await fixture();
	f.sqlite.exec("UPDATE hobo_kv_meta SET total_bytes=1 WHERE id=1");
	expect((await f.send("set", "key", new Uint8Array([3]))).body).toMatchObject({
		error: "outcome-unknown",
	});
	expect(
		f.sqlite.prepare("SELECT COUNT(*) AS n FROM hobo_kv_entries").get(),
	).toMatchObject({ n: 0 });
});

it("matches a bounded two-key state model across every operation", async () => {
	const f = await fixture();
	const values = [undefined, "", "Bw=="] as const;
	const operations = [
		"get",
		"exists",
		"set-empty",
		"set-byte",
		"delete",
	] as const;
	let cases = 0;
	for (const left of values)
		for (const right of values)
			for (const key of ["a", "b"] as const)
				for (const operation of operations) {
					f.sqlite.exec(
						"DELETE FROM hobo_kv_entries; UPDATE hobo_kv_meta SET entries=0,total_bytes=0 WHERE id=1",
					);
					const model = new Map<string, string>();
					for (const [initialKey, value] of [
						["a", left],
						["b", right],
					] as const) {
						if (value !== undefined) {
							model.set(initialKey, value);
							expect(
								(await f.send("set", initialKey, Buffer.from(value, "base64")))
									.status,
							).toBe(200);
						}
					}
					if (operation === "get")
						expect((await f.send("get", key)).body).toMatchObject({
							value: model.get(key) ?? null,
						});
					if (operation === "exists")
						expect((await f.send("exists", key)).body).toMatchObject({
							exists: model.has(key),
						});
					if (operation === "delete") {
						expect((await f.send("delete", key)).status).toBe(200);
						model.delete(key);
					}
					if (operation === "set-empty" || operation === "set-byte") {
						const value = operation === "set-empty" ? "" : "Aw==";
						expect(
							(await f.send("set", key, Buffer.from(value, "base64"))).status,
						).toBe(200);
						model.set(key, value);
					}
					for (const observed of ["a", "b"])
						expect((await f.send("get", observed)).body).toMatchObject({
							value: model.get(observed) ?? null,
						});
					cases++;
				}
	expect(cases).toBe(90);
}, 20_000);
