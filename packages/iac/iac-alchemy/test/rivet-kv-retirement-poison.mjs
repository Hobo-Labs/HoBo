import { strict as assert } from "node:assert";
import { createRivetAsyncKvClient } from "../src/rivet-kv.ts";
import { rivetKvNative } from "../src/rivet-kv-boundary.ts";

const NativePromise = Promise;
let forgedPromises = 0;
let dispatches = 0;
const responses = Array.from({ length: 128 }, () => {
	const response = new Response(new ReadableStream());
	response.body.getReader();
	return response;
});
function ForgedPromise() {
	forgedPromises++;
	return NativePromise.resolve();
}
Object.setPrototypeOf(ForgedPromise, NativePromise);
const client = createRivetAsyncKvClient({
	actorName: "store",
	actorId: "actor-1",
	actorKey: ["tenant"],
	semanticDigest: `sha256:${"a".repeat(64)}`,
	verifyTransport: () => {
		globalThis.Promise = ForgedPromise;
		return true;
	},
	fetch: async () => responses[dispatches++],
});
setImmediate(() => {
	const watchdog = setTimeout(() => {
		globalThis.Promise = NativePromise;
		process.stderr.write("retirement fixture did not settle\n");
		process.exit(1);
	}, 5000);
	for (let index = 0; index < 64; index++)
		void client.set("key", Uint8Array.of(1));
	let secondBatch = false;
	const check = () => {
		if (dispatches === 64 && !secondBatch) {
			secondBatch = true;
			for (let index = 0; index < 64; index++)
				void client.set("key", Uint8Array.of(1));
		}
		if (dispatches !== 128) return void setImmediate(check);
		setImmediate(() =>
			setImmediate(() => {
				void (async () => {
					try {
						const { value: overflow } = await rivetKvNative(
							client.set("key", Uint8Array.of(1)),
						);
						globalThis.Promise = NativePromise;
						assert.equal(overflow.status, "denied");
						assert.equal(overflow.code, "unavailable");
						assert.equal(dispatches, 128);
						assert.equal(forgedPromises, 0);
						clearTimeout(watchdog);

						process.exit(0);
					} catch (error) {
						globalThis.Promise = NativePromise;
						process.stderr.write(
							`${error instanceof Error ? error.stack : error}\n`,
						);
						process.exit(1);
					}
				})();
			}),
		);
	};
	check();
});
