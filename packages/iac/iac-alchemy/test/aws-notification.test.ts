import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vitest";
import {
	createAwsNotificationPublisher,
	inspectAwsNotificationPublisher,
} from "../src/aws-notification.js";

const grant = {
	topicName: "notifications",
	accountId: "000000000000",
	partition: "aws",
	region: "us-east-1",
	resourceEpoch: `sha256:${"a".repeat(64)}`,
	grantEpoch: `sha256:${"b".repeat(64)}`,
};
const request = {
	attemptId: "abcdefghijklmnop",
	body: "Hello 🌎",
	subject: "News",
};
const xml = (id = "ed01a9e1-3456-7890-abcd-123456789012") =>
	new Response(
		`<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><PublishResult><MessageId>${id}</MessageId></PublishResult><ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></PublishResponse>`,
		{ headers: { "content-type": "text/xml" } },
	);
function fixture(
	fetch: typeof globalThis.fetch,
	verify: () => boolean = () => true,
) {
	const layer = Layer.mergeAll(
		Endpoint.of("http://localhost:4566"),
		Credentials.fromCredentials(
			{
				accessKeyId: Redacted.make("local"),
				secretAccessKey: Redacted.make("local"),
			},
			"us-east-1",
		),
		FetchHttpClient.layer,
		Layer.succeed(FetchHttpClient.Fetch, fetch),
	);
	return createAwsNotificationPublisher({ grant, verify, layer });
}

describe("AWS SNS notification submissions", () => {
	it("binds a frozen exact grant to a genuine publisher", () => {
		const publisher = fixture(async () => xml());
		const snapshot = inspectAwsNotificationPublisher(publisher);
		expect(snapshot).toEqual(grant);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(inspectAwsNotificationPublisher({ ...publisher })).toBeUndefined();
		let traps = 0;
		expect(
			inspectAwsNotificationPublisher(
				new Proxy(publisher, {
					get() {
						traps++;
						throw Error();
					},
				}),
			),
		).toBeUndefined();
		expect(traps).toBe(0);
	});
	it("submits exactly the scoped topic, message and subject", async () => {
		let body = "";
		const publisher = fixture(async (_url, init) => {
			body = String(init?.body);
			return xml();
		});
		expect(await publisher.send(request)).toEqual({
			status: "accepted",
			attemptId: request.attemptId,
			receipt: "ed01a9e1-3456-7890-abcd-123456789012",
		});
		const form = new URLSearchParams(body);
		expect(form.get("TopicArn")).toBe(
			"arn:aws:sns:us-east-1:000000000000:notifications",
		);
		expect(form.get("Message")).toBe(request.body);
		expect(form.get("Subject")).toBe(request.subject);
	});
	it("rejects invalid requests and revoked grants before dispatch", async () => {
		let calls = 0;
		const publisher = fixture(
			async () => {
				calls++;
				return xml();
			},
			() => false,
		);
		expect(await publisher.send({ ...request, body: "" })).toEqual({
			status: "rejected",
			code: "invalid-argument",
		});
		expect(await publisher.send(request)).toEqual({
			status: "rejected",
			code: "unauthorized",
		});
		expect(calls).toBe(0);
	});
	it("rejects accessor grants without invoking the accessor", () => {
		let reads = 0;
		const hostile = {
			...grant,
			get topicName() {
				reads++;
				return "notifications";
			},
		};
		const layer = Layer.mergeAll(
			Endpoint.of("http://localhost:4566"),
			Credentials.fromCredentials(
				{
					accessKeyId: Redacted.make("local"),
					secretAccessKey: Redacted.make("local"),
				},
				"us-east-1",
			),
			FetchHttpClient.layer,
		);
		expect(() =>
			createAwsNotificationPublisher({
				grant: hostile,
				verify: () => true,
				layer,
			}),
		).toThrow("invalid_grant");
		expect(reads).toBe(0);
	});
	it("rejects an asynchronous verifier before dispatch", async () => {
		let calls = 0;
		// SAFETY: the test exercises an invalid asynchronous verifier at the host boundary.
		const publisher = fixture(
			async () => {
				calls++;
				return xml();
			},
			(() => Promise.resolve(true)) as never,
		);
		expect(await publisher.send(request)).toEqual({
			status: "rejected",
			code: "unauthorized",
		});
		expect(calls).toBe(0);
	});
	it("keeps an accepted submission unknown if authorization is revoked in flight", async () => {
		let live = true;
		const publisher = fixture(
			async () => {
				live = false;
				return xml();
			},
			() => live,
		);
		expect(await publisher.send(request)).toEqual({
			status: "unknown",
			attemptId: request.attemptId,
		});
	});
	it("does not retry an ambiguous server error", async () => {
		let calls = 0;
		const publisher = fixture(async () => {
			calls++;
			return new Response(
				"<ErrorResponse><Error><Code>InternalError</Code><Message>lost</Message></Error></ErrorResponse>",
				{ status: 500 },
			);
		});
		expect(await publisher.send(request)).toEqual({
			status: "unknown",
			attemptId: request.attemptId,
		});
		expect(calls).toBe(1);
	});
	it("does not report acceptance for an invalid receipt", async () => {
		const publisher = fixture(async () => xml(""));
		expect(await publisher.send(request)).toEqual({
			status: "unknown",
			attemptId: request.attemptId,
		});
	});
	it("holds physical capacity until outstanding transport calls settle", async () => {
		let calls = 0;
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const publisher = fixture(async () => {
			calls++;
			await pending;
			return xml();
		});
		const submissions = Array.from({ length: 32 }, () =>
			publisher.send(request),
		);
		await vi.waitFor(() => expect(calls).toBe(32));
		expect(await publisher.send(request)).toEqual({
			status: "rejected",
			code: "capacity",
		});
		release();
		expect(
			(await Promise.all(submissions)).every(
				(result) => result.status === "accepted",
			),
		).toBe(true);
		expect((await publisher.send(request)).status).toBe("accepted");
	});
	it("keeps timed-out transports in capacity until they physically settle", async () => {
		let calls = 0;
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const publisher = fixture(async () => {
			calls++;
			await pending;
			return xml();
		});
		const submissions = Array.from({ length: 32 }, () =>
			publisher.send(request),
		);
		await vi.waitFor(() => expect(calls).toBe(32));
		expect(
			(await Promise.all(submissions)).every(
				(result) => result.status === "unknown",
			),
		).toBe(true);
		expect(await publisher.send(request)).toEqual({
			status: "rejected",
			code: "capacity",
		});
		release();
		await vi.waitFor(async () =>
			expect((await publisher.send(request)).status).toBe("accepted"),
		);
	}, 20_000);
});
