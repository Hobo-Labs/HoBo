// The reference driver adapter, without a server.
//
// A client that cannot reach its server is the easiest way to get a driver
// error full of deployment detail: the address it dialled, the topology it
// built, and — in the URL it was given — a password. Nothing listens on the
// port used here, so this needs no database and no network beyond loopback.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { parseDatasetSchema } from "@hobo/data-core";
import { MongoClient } from "mongodb";
import { describe, test } from "vitest";
import {
	createMongoEngine,
	MongoCommandError,
	MongoDataError,
} from "../src/index.js";
import { createMongoDriverExecutor } from "./support/driver-executor.js";

const HOST = "127.0.0.1:9";
const PASSWORD = "hunter2-not-a-real-password";
const DEAD_URL = `mongodb://app:${PASSWORD}@${HOST}/?directConnection=true&serverSelectionTimeoutMS=200`;

async function rejection(action: () => Promise<void>): Promise<Error> {
	try {
		await action();
	} catch (cause) {
		assert.ok(cause instanceof Error);
		return cause;
	}
	return assert.fail("expected a rejection");
}

function assertCarriesNoDeploymentDetail(error: Error): void {
	const shown = inspect(error, {
		depth: Number.POSITIVE_INFINITY,
		showHidden: true,
	});
	for (const text of [PASSWORD, HOST, "127.0.0.1", "mongodb://"]) {
		// Never interpolate `shown`: it is the thing that must not be printed.
		assert.ok(!shown.includes(text), "the error carries deployment detail");
	}
	assert.equal(error.cause, undefined, "a driver error is never chained");
}

describe("reference driver adapter: errors without a server", () => {
	test("an unreachable server is a code and a class name — no address, no credential, no cause", async () => {
		const client = new MongoClient(DEAD_URL);
		const executor = createMongoDriverExecutor({ client, database: "app" });
		try {
			const refused = await rejection(async () => {
				await executor.find({ collection: "c", select: { kind: "range" } });
			});
			assert.ok(refused instanceof MongoCommandError, refused.name);
			assert.equal(refused.code, 0);
			assert.equal(refused.codeName, "MongoServerSelectionError");
			assertCarriesNoDeploymentDetail(refused);

			// The same refusal through the binding.
			const binding = createMongoEngine({ executor });
			const surfaced = await rejection(async () => {
				await binding.datasets.ensureDataset(
					parseDatasetSchema({
						name: "orders",
						keyFields: ["id"],
						fields: [{ name: "id", type: "string" }],
					}),
				);
			});
			assert.ok(surfaced instanceof MongoDataError, surfaced.name);
			assert.equal(surfaced.code, "MONGODB_COMMAND_FAILED");
			assert.equal(surfaced.detail.serverCode, 0);
			// Which driver class it is depends on what the client tried last.
			assert.match(String(surfaced.detail.codeName), /^Mongo[A-Za-z]+Error$/u);
			assertCarriesNoDeploymentDetail(surfaced);
		} finally {
			await client.close();
		}
	});

	test("a document the driver would refuse to send is refused with the server's code for it", async () => {
		// No connection is attempted: the size is judged before anything is sent.
		const client = new MongoClient(DEAD_URL);
		const executor = createMongoDriverExecutor({ client, database: "app" });
		try {
			const refused = await rejection(async () => {
				await executor.bulkWrite({
					collection: "c",
					operations: [
						{
							kind: "replace",
							document: { _id: "big", s: "x".repeat(16 * 1024 * 1024) },
						},
					],
				});
			});
			assert.ok(refused instanceof MongoCommandError, refused.name);
			assert.equal(refused.code, 10334);
			assert.equal(refused.codeName, "BSONObjectTooLarge");
		} finally {
			await client.close();
		}
	});
});
