import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import type { NotificationPort } from "@hobo/core/notification";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import {
	awsHttpBindings,
	createAwsBindleApplication,
} from "../src/aws-http-runtime.js";
import { defineAwsHttpSource } from "../src/aws-http-source.js";
import { createAwsNotificationPublisher } from "../src/aws-notification.js";
import { withAwsSnsNotification } from "../src/aws-notification-mapper.js";

const topicArn = "arn:aws:sns:us-east-1:000000000000:alerts";
const request = { attemptId: "abcdefghijklmnop", body: "Hello" };
const response = () =>
	new Response(
		'<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><PublishResult><MessageId>12345678-abcd</MessageId></PublishResult></PublishResponse>',
		{ headers: { "content-type": "text/xml" } },
	);
const grant = {
	topicName: "alerts",
	accountId: "000000000000",
	partition: "aws",
	region: "us-east-1",
	resourceEpoch: `sha256:${"a".repeat(64)}`,
	grantEpoch: `sha256:${"b".repeat(64)}`,
};
function publisher(fetch: typeof globalThis.fetch) {
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
	return createAwsNotificationPublisher({ grant, verify: () => true, layer });
}

it("binds only the genuine publisher for the exact mapped topic", async () => {
	let retained: NotificationPort | undefined;
	const definition = bindle("shop", (b) => {
		const alerts = b.notify().allow("send");
		return {
			alerts,
			web: b
				.web((context) => async () => {
					retained = awsHttpBindings(context).notify("alerts");
					return Response.json(await retained.send(request));
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(alerts),
		};
	});
	const selected = withAwsSnsNotification(definition, { alerts: true });
	let calls = 0;
	const port = publisher(async () => {
		calls++;
		return response();
	});
	const make = (
		name: string,
		value: NotificationPort,
		verifyBinding: () => boolean = () => true,
	) =>
		defineAwsHttpSource({
			bindle: selected,
			applicationName: "web",
			environment: { HOBO_RESOURCE_0: name },
			resolveStores: () => ({ alerts: value }),
			verifyBinding,
		});
	const accepted = await make(topicArn, port).fetch(
		new Request("https://app.test"),
	);
	expect(await accepted.json()).toEqual({
		status: "accepted",
		attemptId: request.attemptId,
		receipt: "12345678-abcd",
	});
	expect(await retained?.send(request)).toEqual({
		status: "rejected",
		code: "unauthorized",
	});
	expect(
		(await make("other", port).fetch(new Request("https://app.test"))).status,
	).toBe(503);
	for (const arn of [
		"arn:aws:sns:us-east-1:111111111111:alerts",
		"arn:aws:sns:us-west-2:000000000000:alerts",
		"arn:aws-us-gov:sns:us-east-1:000000000000:alerts",
	])
		expect(
			(await make(arn, port).fetch(new Request("https://app.test"))).status,
		).toBe(503);
	expect(
		(await make(topicArn, { ...port }).fetch(new Request("https://app.test")))
			.status,
	).toBe(503);
	expect(
		(
			await make(topicArn, new Proxy(port, {})).fetch(
				new Request("https://app.test"),
			)
		).status,
	).toBe(503);
	expect(
		(
			await make(topicArn, port, () => false).fetch(
				new Request("https://app.test"),
			)
		).status,
	).toBe(503);
	expect(calls).toBe(1);
});

it("reports an in-flight send as unknown when the request grant is revoked", async () => {
	let finish!: (value: Response) => void;
	let started!: () => void;
	const dispatch = new Promise<void>((resolve) => {
		started = resolve;
	});
	const port = publisher(
		async () =>
			new Promise<Response>((resolve) => {
				finish = resolve;
				started();
			}),
	);
	let sent: ReturnType<NotificationPort["send"]> | undefined;
	const definition = bindle("shop", (b) => {
		const alerts = b.notify().allow("send");
		return {
			alerts,
			web: b
				.web((context) => async () => {
					sent = awsHttpBindings(context).notify("alerts").send(request);
					await sent;
					return new Response("ok");
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(alerts),
		};
	});
	let authorized = true;
	const app = createAwsBindleApplication({
		bindle: withAwsSnsNotification(definition, { alerts: true }),
		applicationName: "web",
		stores: { alerts: port },
		verifyBinding: () => authorized,
	});
	const incoming = app.fetch(new Request("https://app.test"));
	await dispatch;
	authorized = false;
	finish(response());
	expect(await sent).toEqual({
		status: "unknown",
		attemptId: request.attemptId,
	});
	expect((await incoming).status).toBe(503);
});

it("refuses two declared notifications sharing one physical topic", () => {
	const definition = bindle("shop", (b) => {
		const alerts = b.notify().allow("send");
		const updates = b.notify().allow("send");
		return {
			alerts,
			updates,
			web: b
				.web(() => () => new Response("ok"))
				.with(sessionReplay({ enabled: false }))
				.dependsOn(alerts, updates),
		};
	});
	const port = publisher(async () => response());
	expect(() =>
		createAwsBindleApplication({
			bindle: withAwsSnsNotification(definition, {
				alerts: true,
				updates: true,
			}),
			applicationName: "web",
			stores: { alerts: port, updates: port },
			verifyBinding: () => true,
		}),
	).toThrow("identities must be unique");
});

it("stops notification dispatch when the source topic changes during a request", async () => {
	const environment = { HOBO_RESOURCE_0: topicArn };
	let calls = 0;
	let result: Awaited<ReturnType<NotificationPort["send"]>> | undefined;
	const store = publisher(async () => {
		calls++;
		return response();
	});
	const definition = bindle("shop", (b) => {
		const alerts = b.notify().allow("send");
		return {
			alerts,
			web: b
				.web((context) => async () => {
					const scoped = awsHttpBindings(context).notify("alerts");
					environment.HOBO_RESOURCE_0 = "other-topic";
					result = await scoped.send(request);
					return new Response("ok");
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(alerts),
		};
	});
	const source = defineAwsHttpSource({
		bindle: withAwsSnsNotification(definition, { alerts: true }),
		applicationName: "web",
		environment,
		resolveStores: () => ({ alerts: store }),
		verifyBinding: () => true,
	});
	expect((await source.fetch(new Request("https://app.test"))).status).toBe(
		503,
	);
	expect(result).toEqual({ status: "rejected", code: "unauthorized" });
	expect(calls).toBe(0);
});
