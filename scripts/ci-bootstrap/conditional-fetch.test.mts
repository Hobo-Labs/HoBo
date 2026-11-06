import assert from "node:assert/strict";
import { test } from "node:test";
import { createConditionalGithubFetch } from "./conditional-fetch.mts";

const url =
	"https://api.github.com/repos/Hobo-Labs/HoBo/contents/controllers/123/requests?ref=ops%2Fci-runner-mailbox-5636332-1234abcd";

test("implicit GET revalidation preserves cached content with fresh 304 metadata", async () => {
	const conditions: (string | null)[] = [];
	const fetchImpl: typeof fetch = async (_input, init) => {
		conditions.push(new Headers(init?.headers).get("if-none-match"));
		if (conditions.length === 1)
			return new Response('{"value":"é"}', {
				headers: {
					"content-type": "application/json; charset=utf-8",
					etag: '"v1"',
					"x-ratelimit-remaining": "999",
					"x-ratelimit-reset": "old",
					"retry-after": "60",
				},
			});
		return new Response(null, {
			status: 304,
			headers: {
				etag: '"v1"',
				"x-ratelimit-remaining": "998",
				"x-github-request-id": "fresh",
				"content-length": "0",
			},
		});
	};
	const send = createConditionalGithubFetch(fetchImpl);
	assert.deepEqual(await (await send(url)).json(), { value: "é" });
	const response = await send(url);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), '{"value":"é"}');
	assert.deepEqual(conditions, [null, '"v1"']);
	assert.equal(response.headers.get("x-ratelimit-remaining"), "998");
	assert.equal(response.headers.get("x-ratelimit-reset"), null);
	assert.equal(response.headers.get("retry-after"), null);
	assert.equal(response.headers.get("x-github-request-id"), "fresh");
	assert.equal(
		response.headers.get("content-type"),
		"application/json; charset=utf-8",
	);
	assert.equal(
		response.headers.get("content-length"),
		String(Buffer.byteLength('{"value":"é"}')),
	);
});

test("changed 200 replaces the body and ETag used for later validation", async () => {
	const conditions: (string | null)[] = [];
	const fetchImpl: typeof fetch = async (_input, init) => {
		conditions.push(new Headers(init?.headers).get("if-none-match"));
		if (conditions.length < 3)
			return Response.json(
				{ version: conditions.length },
				{ headers: { etag: `"v${conditions.length}"` } },
			);
		return new Response(null, { status: 304 });
	};
	const send = createConditionalGithubFetch(fetchImpl);
	await (await send(url)).text();
	assert.deepEqual(await (await send(url)).json(), { version: 2 });
	assert.deepEqual(await (await send(url)).json(), { version: 2 });
	assert.deepEqual(conditions, [null, '"v1"', '"v2"']);
});

test("a 403 remains a 403 and never substitutes the cached successful response", async () => {
	let calls = 0;
	const refused = Response.json(
		{ message: "permission denied" },
		{ status: 403, headers: { "x-ratelimit-remaining": "0" } },
	);
	const fetchImpl: typeof fetch = async () =>
		++calls === 1
			? Response.json({ private: "old" }, { headers: { etag: '"v1"' } })
			: refused;
	const send = createConditionalGithubFetch(fetchImpl);
	await (await send(url)).text();
	const response = await send(url);
	assert.equal(response, refused);
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { message: "permission denied" });
});

test("explicit caller conditions preserve raw 304 semantics", async () => {
	let calls = 0;
	const fetchImpl: typeof fetch = async (_input, init) => {
		calls++;
		if (calls === 1)
			return Response.json({ cached: true }, { headers: { etag: '"v1"' } });
		assert.equal(new Headers(init?.headers).get("if-none-match"), '"caller"');
		return new Response(null, { status: 304 });
	};
	const send = createConditionalGithubFetch(fetchImpl);
	await (await send(url)).text();
	const response = await send(url, {
		headers: { "If-None-Match": '"caller"' },
	});
	assert.equal(response.status, 304);
	assert.equal(await response.text(), "");
});

test("a lost mutation acknowledgement is surfaced once without retry or conditional headers", async () => {
	let calls = 0;
	const failure = new Error("lost acknowledgement");
	const fetchImpl: typeof fetch = async (_input, init) => {
		calls++;
		assert.equal(init?.method, "POST");
		assert.equal(new Headers(init?.headers).get("if-none-match"), null);
		throw failure;
	};
	const send = createConditionalGithubFetch(fetchImpl);
	await assert.rejects(
		send(url, { method: "POST", body: "{}" }),
		(error) => error === failure,
	);
	assert.equal(calls, 1);
});

test("authorization and representation variants cannot share a cached body", async () => {
	const conditions: (string | null)[] = [];
	const fetchImpl: typeof fetch = async (_input, init) => {
		conditions.push(new Headers(init?.headers).get("if-none-match"));
		return Response.json(
			{ version: conditions.length },
			{ headers: { etag: `"v${conditions.length}"` } },
		);
	};
	const send = createConditionalGithubFetch(fetchImpl);
	await (
		await send(url, {
			headers: {
				Authorization: "Bearer fixture-A",
				Accept: "application/json",
			},
		})
	).text();
	await (
		await send(url, {
			headers: {
				Authorization: "Bearer fixture-B",
				Accept: "application/json",
			},
		})
	).text();
	await (
		await send(url, {
			headers: {
				Authorization: "Bearer fixture-A",
				Accept: "application/vnd.github+json",
			},
		})
	).text();
	assert.deepEqual(conditions, [null, null, null]);
});

test("oversized tee cancellation returns before the original body is consumed", async () => {
	let calls = 0;
	const conditions: (string | null)[] = [];
	const fetchImpl: typeof fetch = async (_input, init) => {
		calls++;
		conditions.push(new Headers(init?.headers).get("if-none-match"));
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(`{"large":"${"x".repeat(512 * 1024)}"}`),
					);
					controller.close();
				},
			}),
			{ headers: { "content-type": "application/json", etag: '"large"' } },
		);
	};
	const send = createConditionalGithubFetch(fetchImpl);
	for (let index = 0; index < 2; index++) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const response = await Promise.race([
				send(url),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("tee cancellation deadlocked")),
						1000,
					);
				}),
			]);
			assert.equal(response.bodyUsed, false);
			await response.arrayBuffer();
		} finally {
			clearTimeout(timer);
		}
	}
	assert.equal(calls, 2);
	assert.deepEqual(conditions, [null, null]);
});

test("the cache is bounded and evicts its least recently used response", async () => {
	const conditions: (string | null)[] = [];
	const fetchImpl: typeof fetch = async (_input, init) => {
		conditions.push(new Headers(init?.headers).get("if-none-match"));
		return Response.json({}, { headers: { etag: '"v1"' } });
	};
	const send = createConditionalGithubFetch(fetchImpl);
	for (let index = 0; index < 129; index++)
		await (await send(`${url}&page=${index}`)).text();
	await (await send(`${url}&page=0`)).text();
	assert.equal(conditions.at(-1), null);
});
