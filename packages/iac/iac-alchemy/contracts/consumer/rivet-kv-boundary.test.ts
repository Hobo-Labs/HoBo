import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RawAccess } from "rivetkit/db";
import { describe, expect, it } from "vitest";
import { createRivetAsyncKvClient } from "../../src/rivet-kv.js";
import {
	createRivetAsyncKvActor,
	migrateRivetAsyncKv,
} from "../../src/rivet-kv-runtime.js";

const pact = JSON.parse(
	readFileSync(
		new URL("../pacts/rivet-kv-boundary.pact.json", import.meta.url),
		"utf8",
	),
);

describe("Rivet async key-value client and actor contract", () => {
	for (const interaction of pact.interactions) {
		it(interaction.description, async () => {
			const sqlite = new DatabaseSync(":memory:");
			try {
				const execute = async (query: string, ...args: SQLInputValue[]) =>
					sqlite.prepare(query).all(...args);
				const transaction = async <T>(
					run: (transaction: RawAccess) => Promise<T>,
				) => {
					sqlite.exec("BEGIN IMMEDIATE");
					try {
						// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The actor only uses execute on this transaction fixture.
						const result = await run({ execute } as RawAccess);
						sqlite.exec("COMMIT");
						return result;
					} catch (error) {
						sqlite.exec("ROLLBACK");
						throw error;
					}
				};
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: This fixture supplies the two database capabilities used by the actor.
				const database = { execute, transaction } as RawAccess;
				await migrateRivetAsyncKv(database);
				const semanticDigest = `sha256:${"a".repeat(64)}`;
				const actorKey = ["tenant", "app", "incarnation-1"];
				const binding = createRivetAsyncKvActor({
					actorName: "store",
					semanticDigest,
					verifyIngress: () => true,
					authorize: ({ phase, operation }) =>
						interaction.request.scenario !== "refused" ||
						phase !== "operation" ||
						operation !== "set",
				});
				let dispatches = 0;
				const client = createRivetAsyncKvClient({
					actorName: "store",
					actorId: "actor-1",
					actorKey,
					semanticDigest,
					verifyTransport: () => true,
					fetch: async (path, init) => {
						dispatches++;
						const response = await binding.handle(
							{ name: "store", key: actorKey, db: database },
							new Request(`https://actor.test${path}`, init),
						);
						if (
							interaction.request.scenario === "lost-reply" &&
							path === "/set"
						) {
							await response.body?.cancel();
							throw new Error("committed reply lost");
						}
						return response;
					},
				});
				const write = await client.set(
					interaction.request.key,
					Uint8Array.from(interaction.request.bytes),
				);
				const read = await client.get(interaction.request.key);
				const actual = {
					writeStatus: write.status,
					writeCode: write.status === "ok" ? null : write.code,
					readStatus: read.status,
					bytes:
						read.status === "ok" && read.value !== undefined
							? Array.from(read.value)
							: null,
					dispatches,
				};
				expect(actual).toEqual(interaction.response.body);
				if (write.status === "unknown") {
					expect(write.operation.requestId).toMatch(
						/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
					);
					expect(write.operation.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
				}
			} finally {
				sqlite.close();
			}
		});
	}
});
