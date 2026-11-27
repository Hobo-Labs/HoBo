/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: the test adapter implements the raw SQLite actor boundary. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { durableMessagingOperation } from "@hobo/core";
import { migrateDurableTopicJournal } from "@hobo/runtime/durable-topic-journal";
import { ActorHandleRaw } from "rivetkit/client";
import type { RawAccess } from "rivetkit/db";
import { expect, it } from "vitest";
import { createRivetDurableTopicActor } from "../src/durable-topic-actor.js";
import {
	createRivetDurableTopicClient,
	createRivetDurableTopicMetadataGrant,
} from "../src/durable-topic-client.js";

it("preserves malformed and lost-commit outcomes through the actor's SQLite journal", async () => {
	const sql = new DatabaseSync(":memory:");
	let tail = Promise.resolve();
	const execute = async (query: string, ...args: SQLInputValue[]) =>
		sql.prepare(query).all(...args);
	const transaction = async <T>(
		run: (tx: RawAccess) => Promise<T>,
	): Promise<T> => {
		const before = tail;
		let release = () => {};
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await before;
		sql.exec("BEGIN IMMEDIATE");
		try {
			// SAFETY: this fixture's actor transaction uses only execute.
			const result = await run({ execute } as RawAccess);
			sql.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				sql.exec("ROLLBACK");
			} catch {}
			throw error;
		} finally {
			release();
		}
	};
	// SAFETY: the actor uses only execute and transaction in this fixture.
	const db = { execute, transaction } as RawAccess;
	const actorName = "orders";
	const key = ["tenant"];
	const semanticDigest = `sha256:${"a".repeat(64)}`;
	type SignedClaim = {
		readonly actorName: string;
		readonly actorKey: readonly string[];
		readonly tenant: string;
		readonly instance: string;
		readonly semanticDigest: string;
		readonly method: string;
		readonly requestBase64: string;
	};
	const sign = (claim: SignedClaim) =>
		createHmac("sha256", "test-only-key")
			.update(
				JSON.stringify([
					claim.actorName,
					claim.actorKey,
					claim.tenant,
					claim.instance,
					claim.semanticDigest,
					claim.method,
					claim.requestBase64,
				]),
			)
			.digest("hex");
	try {
		await migrateDurableTopicJournal(db);
		const actor = createRivetDurableTopicActor({
			actorName,
			semanticDigest,
			now: () => 1000,
			resolveScope: ({ actorKey }) => ({
				tenant: actorKey[0] ?? "",
				instance: "topic",
			}),
			authorize: (claim) => {
				const proof = claim.headers.get("x-hobo-proof");
				const expected = sign(claim);
				return (
					proof !== null &&
					/^[a-f0-9]{64}$/u.test(proof) &&
					timingSafeEqual(
						Buffer.from(proof, "hex"),
						Buffer.from(expected, "hex"),
					)
				);
			},
			verifyIngress: ({
				maxRequestBytes,
				maxChunkBytes,
				maxHeaderBytes,
				maxChunks,
			}) =>
				maxRequestBytes === 131_072 &&
				maxChunkBytes === 65_536 &&
				maxHeaderBytes === 16_384 &&
				maxChunks === 4096,
		});
		let dropPath = "";
		let retryPath = "";
		let replayCount = 0;
		const fetch = async (path: string, init: RequestInit) => {
			const response = await actor.handle(
				{ name: actorName, key, db },
				new Request(`https://actor.test${path}`, init),
			);
			if (dropPath === path) {
				dropPath = "";
				await response.arrayBuffer();
				throw new Error("reply lost after commit");
			}
			if (retryPath === path) {
				retryPath = "";
				const first = await response.text();
				const retried = new Request(`https://actor.test${path}`, init);
				expect(await retried.clone().text()).toBe(init.body);
				const replay = await actor.handle(
					{ name: actorName, key, db },
					retried,
				);
				expect(await replay.clone().text()).toBe(first);
				replayCount++;
				return replay;
			}
			return response;
		};
		const client = createRivetDurableTopicClient({
			binding: {
				actorName,
				actorKey: key,
				tenant: "tenant",
				instance: "topic",
				semanticDigest,
				limits: actor.limits,
				actorCapabilities: actor.capabilities,
			},
			metadataGrant: createRivetDurableTopicMetadataGrant(),
			verifyTransport: (claim) => claim.fetch === fetch,
			authorize: (claim) => ({ "x-hobo-proof": sign(claim) }),
			revalidate: () => true,
			fetch,
		});
		const op = (nonce: string) =>
			durableMessagingOperation(10_000, nonce.padStart(16, "0"));
		const invalidTopic = {
			operation: op("topic-invalid"),
			topic: "forbidden",
			extra: true,
		};
		expect(await client.ensureTopic(invalidTopic)).toEqual({
			status: "rejected",
			code: "invalid-argument",
		});
		expect(await client.ensureTopic(invalidTopic)).toEqual({
			status: "rejected",
			code: "invalid-argument",
		});
		expect(
			await client.readRetainedLog({
				topic: "forbidden",
				afterSequence: 0,
				limit: 1,
			}),
		).toEqual({ status: "rejected", code: "not-found" });
		const topic = { operation: op("topic-valid"), topic: "orders" };
		dropPath = "/ensure-topic";
		expect(await client.ensureTopic(topic)).toEqual({
			status: "unknown",
			operation: topic.operation,
		});
		const alteredTopic = { ...topic, extra: true };
		expect(await client.ensureTopic(alteredTopic)).toEqual({
			status: "rejected",
			code: "operation-conflict",
		});
		expect(await client.ensureTopic(topic)).toEqual({
			status: "committed",
			value: { topic: "orders" },
		});
		const publish = {
			operation: op("publish-valid"),
			topic: "orders",
			message: {
				id: "m1",
				subject: "created",
				payload: new Uint8Array([0]),
				attributes: [],
			},
		};
		dropPath = "/publish";
		expect(await client.publish(publish)).toEqual({
			status: "unknown",
			operation: publish.operation,
		});
		expect(
			await client.publish({
				...publish,
				// @ts-expect-error A string payload is intentionally invalid at the JS boundary.
				message: { ...publish.message, payload: "AA==" },
			}),
		).toEqual({ status: "rejected", code: "operation-conflict" });
		expect(await client.publish(publish)).toEqual({
			status: "committed",
			value: { messageId: "m1", sequence: 1 },
		});
		const malformed = {
			...publish,
			operation: op("publish-invalid"),
			message: { ...publish.message, id: "m2", payload: "AA==" },
		};
		// @ts-expect-error A base64-looking string must remain an invalid JS payload.
		expect(await client.publish(malformed)).toEqual({
			status: "rejected",
			code: "invalid-argument",
		});
		// @ts-expect-error An identical malformed replay must read the durable receipt.
		expect(await client.publish(malformed)).toEqual({
			status: "rejected",
			code: "invalid-argument",
		});
		expect(
			await client.publish({
				...malformed,
				message: { ...malformed.message, payload: new Uint8Array([0]) },
			}),
		).toEqual({ status: "rejected", code: "operation-conflict" });
		const invalidCompact = {
			operation: op("compact-invalid"),
			topic: "orders",
			throughSequence: 1,
			extra: true,
		};
		expect(await client.compact(invalidCompact)).toEqual({
			status: "rejected",
			code: "invalid-argument",
		});
		expect(await client.compact(invalidCompact)).toEqual({
			status: "rejected",
			code: "invalid-argument",
		});
		const page = await client.readRetainedLog({
			topic: "orders",
			afterSequence: 0,
			limit: 4,
		});
		expect(page.status).toBe("ok");
		if (page.status !== "ok") throw new Error("missing retained log");
		expect(page.messages.map((message) => message.id)).toEqual(["m1"]);
		const compact = {
			operation: op("compact-valid"),
			topic: "orders",
			throughSequence: 1,
		};
		dropPath = "/compact";
		expect(await client.compact(compact)).toEqual({
			status: "unknown",
			operation: compact.operation,
		});
		const alteredCompact = { ...compact, extra: true };
		expect(await client.compact(alteredCompact)).toEqual({
			status: "rejected",
			code: "operation-conflict",
		});
		expect(await client.compact(compact)).toEqual({
			status: "committed",
			value: { topic: "orders", firstAvailableSequence: 2, removedMessages: 1 },
		});
		expect(
			await client.readRetainedLog({
				topic: "orders",
				afterSequence: 0,
				limit: 4,
			}),
		).toEqual({ status: "gap", firstAvailableSequence: 2, latestSequence: 1 });
		const transportRetry = {
			...publish,
			operation: op("transparent-retry"),
			message: { ...publish.message, id: "m2" },
		};
		retryPath = "/publish";
		expect(await client.publish(transportRetry)).toEqual({
			status: "committed",
			value: { messageId: "m2", sequence: 2 },
		});
		expect(replayCount).toBe(1);
		const afterRetry = await client.readRetainedLog({
			topic: "orders",
			afterSequence: 1,
			limit: 4,
		});
		if (afterRetry.status !== "ok") throw new Error("missing retried log");
		expect(afterRetry.messages.map((message) => message.id)).toEqual(["m2"]);
		const audit = await client.events({ afterSequence: 0, limit: 10 });
		if (audit.status !== "ok") throw new Error("missing audit page");
		expect(
			audit.events.filter(
				(event) => event.kind === "published" && event.messageId === "m2",
			),
		).toHaveLength(1);

		let sdkAttempts = 0;
		let sdkFirstBody = "";
		let sdkFirstProof: string | null = null;
		let sdkFirstReply = "";
		type SdkDriver = ConstructorParameters<typeof ActorHandleRaw>[1];
		const sdkDriver: Pick<SdkDriver, "sendRequest"> = {
			async sendRequest(
				target: Parameters<SdkDriver["sendRequest"]>[0],
				request: Request,
			) {
				sdkAttempts++;
				expect(target).toEqual({
					getOrCreateForKey: { name: actorName, key },
				});
				expect(new URL(request.url).pathname).toBe("/request/publish");
				const body = await request.text();
				const proof = request.headers.get("x-hobo-proof");
				if (sdkAttempts === 1) {
					sdkFirstBody = body;
					sdkFirstProof = proof;
				} else {
					expect(body).toBe(sdkFirstBody);
					expect(proof).toBe(sdkFirstProof);
				}
				const response = await actor.handle(
					{ name: actorName, key, db },
					new Request("https://actor.test/publish", {
						method: request.method,
						headers: request.headers,
						body,
					}),
				);
				if (sdkAttempts === 1) {
					sdkFirstReply = await response.text();
					return Response.json(
						{ group: "actor", code: "dropped_reply", message: "reply lost" },
						{ status: 503 },
					);
				}
				expect(await response.clone().text()).toBe(sdkFirstReply);
				return response;
			},
		};
		// SAFETY: raw fetch uses only sendRequest on this test driver.
		const sdk = new ActorHandleRaw(
			{},
			sdkDriver as SdkDriver,
			undefined,
			undefined,
			"json",
			{ getOrCreateForKey: { name: actorName, key } },
		);
		const sdkFetch = (path: string, init: RequestInit) => sdk.fetch(path, init);
		const sdkClient = createRivetDurableTopicClient({
			binding: {
				actorName,
				actorKey: key,
				tenant: "tenant",
				instance: "topic",
				semanticDigest,
				limits: actor.limits,
				actorCapabilities: actor.capabilities,
			},
			metadataGrant: createRivetDurableTopicMetadataGrant(),
			verifyTransport: (claim) => claim.fetch === sdkFetch,
			authorize: (claim) => ({ "x-hobo-proof": sign(claim) }),
			revalidate: () => true,
			fetch: sdkFetch,
		});
		expect(
			await sdkClient.publish({
				...publish,
				operation: op("sdk-retry"),
				message: { ...publish.message, id: "m3" },
			}),
		).toEqual({ status: "committed", value: { messageId: "m3", sequence: 3 } });
		expect(sdkAttempts).toBe(2);
		const afterSdkRetry = await client.readRetainedLog({
			topic: "orders",
			afterSequence: 2,
			limit: 4,
		});
		if (afterSdkRetry.status !== "ok") throw new Error("missing SDK retry log");
		expect(afterSdkRetry.messages.map((message) => message.id)).toEqual(["m3"]);
		const sdkAudit = await client.events({ afterSequence: 0, limit: 10 });
		if (sdkAudit.status !== "ok") throw new Error("missing SDK audit page");
		expect(
			sdkAudit.events.filter(
				(event) => event.kind === "published" && event.messageId === "m3",
			),
		).toHaveLength(1);
	} finally {
		sql.close();
	}
});
