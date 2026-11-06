import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createContentsClient } from "./contents.mts";
import { SignedRequestSchema } from "./protocol.mts";
import { createRequestPump } from "./run-loop.mts";

const branch = "ops/ci-runner-mailbox-5636332-1234abcd",
	runId = 987,
	root = `controllers/${runId}`,
	id = "a".repeat(32);
function fixtureRequest(): string {
	return JSON.stringify(
		SignedRequestSchema.parse({
			request: {
				version: 1,
				id,
				issuedAt: 1,
				notAfter: 1000,
				installationId: 20,
				repositoryId: 1274791462,
				runId,
				runAttempt: 1,
				sourceSha: "a".repeat(40),
				workerKey: "b".repeat(64),
				controllerKey: "c".repeat(64),
				method: "GET",
				path: "/repos/Hobo-Labs/HoBo/actions/runners",
				body: null,
				ifNoneMatch: null,
				capability: null,
			},
			signature: "fixture",
		}),
	);
}
function fixture() {
	const files = new Map<string, string>();
	let puts = 0,
		conflict = false,
		loseAck = false;
	const fetchImpl: typeof fetch = async (input, init) => {
		const u = new URL(input instanceof Request ? input.url : input.toString()),
			path = decodeURIComponent(
				z.string().parse(u.pathname.split("/contents/")[1]),
			);
		assert.equal(u.origin, "https://api.github.com");
		assert.match(
			new Headers(init?.headers).get("Authorization") ?? "",
			/^Bearer /,
		);
		if (init?.method === "GET") {
			if (path === `${root}/requests`) {
				const entries = [...files.keys()]
					.filter((k) => k.startsWith(path + "/"))
					.map((k) => ({
						type: "file",
						path: k,
						name: k.slice(path.length + 1),
					}));
				return entries.length
					? Response.json(entries)
					: new Response(null, { status: 404 });
			}
			const text = files.get(path);
			if (text === undefined) return new Response(null, { status: 404 });
			const raw = Buffer.from(text);
			return Response.json({
				type: "file",
				path,
				size: raw.length,
				encoding: "base64",
				content: raw.toString("base64"),
			});
		}
		if (init?.method === "PUT") {
			puts++;
			const data = z
				.object({ branch: z.string(), content: z.string() })
				.parse(JSON.parse(z.string().parse(init.body)));
			assert.equal(data.branch, branch);
			if (conflict) {
				conflict = false;
				return new Response(null, { status: 409 });
			}
			if (files.has(path)) return new Response(null, { status: 422 });
			files.set(path, Buffer.from(data.content, "base64").toString());
			if (loseAck) {
				loseAck = false;
				throw new Error("fixture secret must not leak");
			}
			return Response.json({ ok: true }, { status: 201 });
		}
		throw new Error("unexpected");
	};
	const client = createContentsClient({
		token: "fixture-only-token",
		branch,
		runId,
		fetchImpl,
	});
	return {
		client,
		files,
		get puts() {
			return puts;
		},
		conflict() {
			conflict = true;
		},
		loseAck() {
			loseAck = true;
		},
	};
}
test("branch scope and immutable response", async () => {
	assert.throws(() =>
		createContentsClient({ token: "x", branch: "main", runId }),
	);
	const h = fixture();
	await h.client.publish("response", id, "ciphertext");
	await h.client.publish("response", id, "ciphertext");
	assert.equal(h.puts, 1);
	await assert.rejects(
		h.client.publish("response", id, "different"),
		/collision/,
	);
	await assert.rejects(h.client.publish("request", id, "not allowed"));
});
test("conflict and lost publication acknowledgements only retry same ciphertext", async () => {
	const h = fixture();
	h.conflict();
	await h.client.publish("response", id, "sealed");
	assert.equal(h.puts, 2);
	const id2 = "b".repeat(32);
	h.loseAck();
	await h.client.publish("response", id2, "sealed-two");
	assert.equal(h.puts, 3);
	assert.equal(await h.client.get("response", id2), "sealed-two");
});
test("only bounded canonical request filenames are enumerated", async () => {
	const h = fixture();
	h.files.set(`${root}/requests/${id}.json`, "{}");
	assert.deepEqual(await h.client.listRequests(), [id]);
	h.files.set(`${root}/requests/evil.json`, "{}");
	await assert.rejects(h.client.listRequests(), /invalid mailbox entry/);
});
test("pump retries publishing cached sealed reply and never repeats effect", async () => {
	let effects = 0,
		publishes = 0;
	const contents = {
		async listRequests() {
			return [id];
		},
		async get() {
			return fixtureRequest();
		},
		async publish(_kind: string, _id: string | undefined, text: string) {
			publishes++;
			assert.equal(text, JSON.stringify({ ciphertext: "sealed" }));
			if (publishes === 1) throw new Error("lost acknowledgement");
		},
	};
	const controller = {
		async handle() {
			effects++;
			return { ciphertext: "sealed" };
		},
	};
	const pump = createRequestPump({ contents, controller });
	await pump.step();
	assert.equal(pump.pendingCount(), 1);
	await pump.step();
	assert.equal(pump.pendingCount(), 0);
	await pump.step();
	assert.equal(effects, 1);
	assert.equal(publishes, 2);
});
test("transient request read retries without tombstoning an immutable request", async () => {
	let reads = 0,
		effects = 0;
	const contents = {
		async listRequests() {
			return [id];
		},
		async get() {
			reads++;
			if (reads === 1) throw new Error("transient");
			return fixtureRequest();
		},
		async publish() {},
	};
	const controller = {
		async handle() {
			effects++;
			return { ciphertext: "sealed" };
		},
	};
	const pump = createRequestPump({ contents, controller });
	await pump.step();
	assert.equal(effects, 0);
	await pump.step();
	assert.equal(effects, 1);
	await pump.step();
	assert.equal(effects, 1);
});

test("oversized mailbox replies cancel their stream before parsing", async () => {
	let cancelled = false;
	const fetchImpl: typeof fetch = async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
				},
				cancel() {
					cancelled = true;
				},
			}),
		);
	const client = createContentsClient({
		token: "fixture-only-token",
		branch,
		runId,
		fetchImpl,
	});
	await assert.rejects(client.get("sealed-key"), /mailbox response too large/);
	assert.equal(cancelled, true);
});
