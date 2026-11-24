import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RawAccess } from "rivetkit/db";
import { expect, it } from "vitest";
import { createRivetHttpKvApplication } from "../src/rivet-http-kv.js";
import {
	createRivetAsyncKvActor,
	migrateRivetAsyncKv,
} from "../src/rivet-kv-runtime.js";

it("binds the HTTP application to the real KV actor and SQLite transaction", async () => {
	const sqlite = new DatabaseSync(":memory:");
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
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture actor only calls execute on the transaction.
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
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this actor only uses the execute and transaction capabilities.
	const database = { execute, transaction } as RawAccess;
	const semanticDigest = `sha256:${"d".repeat(64)}`;
	let rejectDelivery = false;
	try {
		await migrateRivetAsyncKv(database);
		const storage = createRivetAsyncKvActor({
			actorName: "settings",
			semanticDigest,
			verifyIngress: ({ actorKey }) =>
				actorKey.join("/") === "tenant-a/settings",
			authorize: ({ headers, phase }) =>
				headers.get("authorization") === "kv-test" &&
				!(phase === "delivery" && rejectDelivery),
		});
		let active = true;
		let revokeOnReceipt = false;
		let dispatches = 0;
		const journal: { requestId: string; fingerprint: string }[] = [];
		const application = createRivetHttpKvApplication({
			actorName: "web",
			storage,
			transport: {
				actorName: "settings",
				actorId: "fixed-actor",
				actorKey: ["tenant-a", "settings"],
				semanticDigest,
				verifyTransport: (claim) => {
					if (claim.phase === "dispatch")
						journal.push({
							requestId: claim.requestId,
							fingerprint: claim.fingerprint,
						});
					if (claim.phase === "receipt" && revokeOnReceipt) active = false;

					return claim.actorId === "fixed-actor" && claim.singleDispatch;
				},
				fetch: async (path, init) => {
					dispatches++;
					const headers = new Headers(init.headers);
					headers.set("authorization", "kv-test");
					return storage.handle(
						{ name: "settings", key: ["tenant-a", "settings"], db: database },
						new Request(`https://kv.test${path}`, { ...init, headers }),
					);
				},
			},
			verifyScope: () => active,
			authorize: ({ actorKey, request }) =>
				actorKey[0] === "tenant-a" &&
				request.headers.get("authorization") === "http-test",
			application: (kv) => async (request) => {
				if (new URL(request.url).pathname === "/delivery-denied") {
					const result = await kv.set(
						"after-delivery-denied",
						new TextEncoder().encode("committed"),
					);
					return Response.json(result, {
						status: result.status === "unknown" ? 503 : 200,
					});
				}
				if (new URL(request.url).pathname === "/throw") {
					await kv.set("after-throw", new TextEncoder().encode("committed"));
					throw new Error("application failed after commit");
				}
				if (request.method === "POST")
					return Response.json(
						await kv.set("greeting", new TextEncoder().encode("hello")),
					);
				const result = await kv.get("greeting");
				return result.status === "ok"
					? Response.json({
							status: result.status,
							value: result.value && new TextDecoder().decode(result.value),
						})
					: Response.json(result);
			},
		});
		const call = (method: string, key = "tenant-a", path = "/") =>
			application.http.handle(
				{ name: "web", key: [key], vars: {} },
				new Request(`https://app.test${path}`, {
					method,
					headers: { authorization: "http-test" },
				}),
			);
		expect((await call("POST", "tenant-b")).status).toBe(403);
		expect(dispatches).toBe(0);
		expect(await (await call("POST")).json()).toEqual({ status: "ok" });
		expect(await (await call("GET")).json()).toEqual({
			status: "ok",
			value: "hello",
		});
		const thrown = await call("POST", "tenant-a", "/throw");
		expect(thrown.status).toBe(503);
		expect(await thrown.json()).toEqual({
			error: "application-failed",
			execution: "possibly-completed",
		});
		expect(
			sqlite
				.prepare("SELECT value FROM hobo_kv_entries WHERE key = ?")
				.get("after-throw"),
		).toEqual({ value: Buffer.from("committed").toString("base64") });
		expect(journal[2]).toMatchObject({
			requestId: expect.any(String),
			fingerprint: expect.any(String),
		});
		rejectDelivery = true;
		const deniedDelivery = await call("POST", "tenant-a", "/delivery-denied");
		expect(deniedDelivery.status).toBe(503);
		expect(await deniedDelivery.json()).toEqual({
			status: "unknown",
			code: "outcome-unknown",
			operation: journal[3],
		});
		expect(
			sqlite
				.prepare("SELECT value FROM hobo_kv_entries WHERE key = ?")
				.get("after-delivery-denied"),
		).toEqual({ value: Buffer.from("committed").toString("base64") });
		rejectDelivery = false;
		revokeOnReceipt = true;
		const result = await call("POST");
		expect(result.status).toBe(503);
		expect(await result.json()).toMatchObject({
			execution: "possibly-completed",
		});
		expect(
			sqlite
				.prepare("SELECT value FROM hobo_kv_entries WHERE key = ?")
				.get("greeting"),
		).toEqual({ value: Buffer.from("hello").toString("base64") });
		expect(dispatches).toBe(5);
	} finally {
		sqlite.close();
	}
});
