// biome-ignore-all lint/suspicious/noThenProperty: This isolated process intentionally tests hostile thenable inheritance.
/* oxlint-disable unicorn/no-thenable -- SAFETY: the isolated fixture deliberately poisons and restores then. */
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { rivetKvNative } from "../src/rivet-kv-boundary.ts";
import { kvFingerprint } from "../src/rivet-kv-protocol.ts";
import {
	createRivetAsyncKvActor,
	migrateRivetAsyncKv,
} from "../src/rivet-kv-runtime.ts";

const sqlite = new DatabaseSync(":memory:");

const execute = async (query, ...args) => {
	const rows = sqlite.prepare(query).all(...args);
	Object.setPrototypeOf(rows, null);
	return rows;
};
const database = {
	execute,
	transaction: async (run) => {
		sqlite.exec("BEGIN IMMEDIATE");
		try {
			const { value } = await rivetKvNative(run({ execute }));
			sqlite.exec("COMMIT");
			return value;
		} catch (error) {
			sqlite.exec("ROLLBACK");
			throw error;
		}
	},
};
const digest = `sha256:${"a".repeat(64)}`;
let traps = 0;
let poisonOnOperation = false;
const fieldNames = ["then"];
const fields = fieldNames.map((name) => {
	const descriptor = Object.create(null);
	descriptor.get = () => {
		traps++;
		throw new Error(`unexpected inherited ${name}`);
	};
	descriptor.configurable = true;
	return {
		name,
		previous: Object.getOwnPropertyDescriptor(Object.prototype, name),
		descriptor: Object.freeze(descriptor),
	};
});
const restore = () => {
	for (const field of fields)
		Reflect.deleteProperty(Object.prototype, field.name);
	for (const field of fields)
		if (field.previous)
			Object.defineProperty(Object.prototype, field.name, field.previous);
};
const actor = createRivetAsyncKvActor({
	actorName: "store",
	semanticDigest: digest,
	verifyIngress: () => true,
	authorize: ({ phase }) => {
		if (phase === "operation" && poisonOnOperation) {
			poisonOnOperation = false;
			for (const field of fields)
				Object.defineProperty(Object.prototype, field.name, field.descriptor);
		}
		return true;
	},
});
function request(operation, requestId, encoded) {
	const body = { requestId, key: "key" };
	if (encoded !== undefined) body.value = encoded;
	return new Request(`https://actor.test/${operation}`, {
		method: "POST",
		headers: {
			"x-hobo-kv-request-id": requestId,
			"x-hobo-kv-fingerprint": kvFingerprint(
				digest,
				operation,
				requestId,
				"key",
				encoded,
			),
			"x-hobo-kv-semantic-digest": digest,
		},
		body: JSON.stringify(body),
	});
}
setImmediate(() => {
	const watchdog = setTimeout(() => {
		restore();
		process.stderr.write("actor operation did not settle\n");
		process.exitCode = 1;
	}, 5000);
	void (async () => {
		try {
			await rivetKvNative(migrateRivetAsyncKv(database));
			const set = request(
				"set",
				"00000000-0000-4000-8000-000000000001",
				"AQI=",
			);
			const get = request("get", "00000000-0000-4000-8000-000000000002");
			poisonOnOperation = true;
			const { value: written } = await rivetKvNative(
				actor.handle({ name: "store", key: ["tenant"], db: database }, set),
			);
			restore();
			assert.equal(written.status, 200);
			assert.equal(
				sqlite
					.prepare("SELECT value FROM hobo_kv_entries WHERE key=?")
					.get("key").value,
				"AQI=",
			);
			poisonOnOperation = true;
			const { value: read } = await rivetKvNative(
				actor.handle({ name: "store", key: ["tenant"], db: database }, get),
			);
			restore();
			assert.equal(read.status, 200);
			assert.equal((await read.json()).value, "AQI=");
			assert.equal(traps, 0);
		} catch (error) {
			restore();
			process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
			process.exitCode = 1;
		} finally {
			restore();
			clearTimeout(watchdog);
			sqlite.close();
		}
	})();
});
