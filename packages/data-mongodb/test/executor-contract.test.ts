// The executor pact, replayed. The same file is replayed against a real
// replica set in `live.test.ts`; that the two providers satisfy one contract
// is the evidence that the in-memory executor is a faithful stand-in.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createMemoryMongoExecutor } from "../src/index.js";
import { isJsonArray, isJsonObject } from "../src/json.js";
import { loadExecutorPact, replayExecutorPact } from "./support/pact.js";

describe("MongoExecutor pact", () => {
	test("the pact names a consumer, a provider, and its interactions", () => {
		const pact = loadExecutorPact();
		assert.ok(isJsonObject(pact.consumer));
		assert.ok(isJsonObject(pact.provider));
		assert.ok(isJsonArray(pact.interactions) && pact.interactions.length > 0);
	});

	test("the in-memory executor honours every interaction", async () => {
		const executor = createMemoryMongoExecutor();
		assert.deepEqual(await replayExecutorPact(executor), []);
		await executor.close();
	});

	test("the pact carries no connection string or credential", () => {
		const text = JSON.stringify(loadExecutorPact());
		assert.ok(!/mongodb(\+srv)?:\/\//u.test(text));
		assert.ok(!/password|secret/iu.test(text));
	});
});
