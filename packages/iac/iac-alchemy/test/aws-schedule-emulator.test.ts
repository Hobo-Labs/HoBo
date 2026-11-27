import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { Schedule, ScheduleProvider } from "@alchemy.run/aws/Scheduler";
import { Queue, QueueProvider } from "@alchemy.run/aws/SQS";
import * as IAM from "@distilled.cloud/aws/iam";
import * as Scheduler from "@distilled.cloud/aws/scheduler";
import * as SQS from "@distilled.cloud/aws/sqs";
import { NodeHttpClient } from "@effect/platform-node";
import { evaluate } from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import { ResourceContext } from "alchemy/ResourceContext";
import { Stack } from "alchemy/Stack";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { cadence } from "../../../bindles/src/cadence.js";
import { awsBindleMappers } from "../src/aws.js";
import { awsStaticScheduleMappers } from "../src/aws-schedule.js";
import { mapBindleToAlchemy } from "../src/bindle.js";

describe("AWS static schedules in the official emulator", () => {
	const official = process.env.HOBO_ALCHEMY_AWS_EMULATOR === "1" ? it : it.skip;
	official(
		"provisions the mapped queue and schedule and delivers its message",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "");
			if (
				endpoint.protocol !== "https:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			)
				throw new Error("AWS Emulator endpoint must be HTTPS loopback");
			const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
			if (!caPath) throw new Error("AWS Emulator CA is required");
			const ca = await readFile(caPath);
			const credentials = {
				accessKeyId: Redacted.make("local"),
				secretAccessKey: Redacted.make("local"),
			};
			const name = `hobo-schedule-${randomUUID().slice(0, 8)}`;
			const stack = {
				name,
				stage: "test",
				resources: {},
				bindings: {},
				actions: {},
			};
			const layer = Layer.mergeAll(
				Endpoint.of(endpoint.origin),
				Credentials.fromCredentials(credentials, "us-east-1"),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca, servername: "localhost" },
				}),
				Layer.succeed(
					AWSEnvironment,
					Effect.succeed({
						accountId: "000000000000",
						region: "us-east-1",
						credentials: Effect.succeed({
							...credentials,
							region: "us-east-1",
							sessionToken: undefined,
						}),
					}),
				),
				Layer.succeed(Stack, stack),
				Layer.succeed(Stage, "test"),
				Layer.succeed(ResourceContext, {
					logicalId: "queue",
					fqn: "queue",
					instanceId: "12345678901234567890123456789012",
					type: Queue.Type,
				}),
			);
			// SAFETY: the fixture supplies the AWS services needed by each emulator operation.
			const run = <T>(effect: Effect.Effect<T, unknown, never>) =>
				Effect.runPromise(Effect.provide(effect, layer));
			let queueUrl: string | undefined;
			let scheduleName: string | undefined;
			let roleCreated = false;
			let policyCreated = false;
			try {
				const role = await run(
					// SAFETY: the test layer provides IAM credentials and an emulator HTTP transport.
					IAM.createRole({
						RoleName: name,
						AssumeRolePolicyDocument: JSON.stringify({
							Version: "2012-10-17",
							Statement: [
								{
									Effect: "Allow",
									Principal: { Service: "scheduler.amazonaws.com" },
									Action: "sts:AssumeRole",
								},
							],
						}),
					}) as Effect.Effect<IAM.CreateRoleResponse, unknown, never>,
				);
				roleCreated = true;
				if (!role.Role?.Arn) throw new Error("emulator role has no ARN");
				const app = bindle(name, (b) => {
					const queue = b.queue();
					return {
						queue,
						tick: b.schedule().dependsOn(queue).with(cadence("* * * * *")),
					};
				});
				const body = '{"kind":"repair 🔧"}';
				// SAFETY: the test registers resources without deploying them in this step.
				const mapped = await Effect.runPromise(
					mapBindleToAlchemy(
						app,
						awsStaticScheduleMappers(awsBindleMappers(), {
							tick: { roleArn: role.Role.Arn, input: body },
						}),
						{ assessRequirements: () => ({ status: "supported" }) },
					).pipe(Effect.provideService(StackContext, stack)) as Effect.Effect<
						import("../src/bindle.js").AlchemyBindleMapping
					>,
				);
				const queue = mapped.primary.queue;
				const schedule = mapped.primary.tick;
				if (
					!queue ||
					queue.Type !== Queue.Type ||
					!schedule ||
					schedule.Type !== Schedule.Type
				)
					throw new Error("mapped resources are missing");
				// SAFETY: this layer provides the selected queue provider's services.
				const queueOutput = await run(
					Effect.gen(function* () {
						const provider = yield* Provider.Provider<Queue>(Queue.Type);
						if (!provider.precreate)
							throw new Error("queue precreate unavailable");
						return yield* provider.precreate({
							id: queue.LogicalId,
							fqn: queue.FQN,
							instanceId: "12345678901234567890123456789012",
							session: noopSession,
							bindings: [],
							news: queue.Props,
						});
					}).pipe(Effect.provide(QueueProvider())) as Effect.Effect<
						Queue["Attributes"],
						unknown,
						never
					>,
				);
				queueUrl = queueOutput.queueUrl;
				await run(
					// SAFETY: the test layer provides IAM credentials and an emulator HTTP transport.
					IAM.putRolePolicy({
						RoleName: name,
						PolicyName: "send",
						PolicyDocument: JSON.stringify({
							Version: "2012-10-17",
							Statement: [
								{
									Effect: "Allow",
									Action: "sqs:SendMessage",
									Resource: queueOutput.queueArn,
								},
							],
						}),
					}) as Effect.Effect<unknown, unknown, never>,
				);
				policyCreated = true;
				// SAFETY: the mapped queue output is the only upstream dependency of the schedule.
				const props = await run(
					evaluate(schedule.Props, {
						[queue.FQN]: queueOutput,
					}) as Effect.Effect<Schedule["Props"], unknown, never>,
				);
				expect(props.target).toMatchObject({
					Arn: queueOutput.queueArn,
					RoleArn: role.Role.Arn,
					Input: body,
				});
				// SAFETY: this layer provides the selected schedule provider's services.
				const output = await run(
					Effect.gen(function* () {
						const provider = yield* Provider.Provider<Schedule>(Schedule.Type);
						return yield* provider.reconcile({
							id: schedule.LogicalId,
							fqn: schedule.FQN,
							instanceId: "12345678901234567890123456789012",
							session: noopSession,
							bindings: [],
							news: props,
							olds: undefined,
							output: undefined,
						});
					}).pipe(Effect.provide(ScheduleProvider())) as Effect.Effect<
						Schedule["Attributes"],
						unknown,
						never
					>,
				);
				scheduleName = output.scheduleName;
				let delivered = false;
				for (let attempt = 0; attempt < 18 && !delivered; attempt++) {
					const started = Date.now();
					const received = await run(
						// SAFETY: the test layer provides SQS credentials and an emulator HTTP transport.
						SQS.receiveMessage({
							QueueUrl: queueUrl,
							WaitTimeSeconds: 5,
							MaxNumberOfMessages: 1,
						}) as Effect.Effect<
							{ Messages?: { Body?: string }[] },
							unknown,
							never
						>,
					);
					delivered =
						received.Messages?.some((message) => message.Body === body) ??
						false;
					const remaining = 5_000 - (Date.now() - started);
					if (!delivered && remaining > 0)
						await new Promise((resolveDelay) =>
							setTimeout(resolveDelay, remaining),
						);
				}
				expect(delivered).toBe(true);
			} finally {
				if (scheduleName)
					await run(
						// SAFETY: the test layer provides Scheduler credentials and an emulator HTTP transport.
						Scheduler.deleteSchedule({ Name: scheduleName }) as Effect.Effect<
							unknown,
							unknown,
							never
						>,
					);
				if (policyCreated)
					await run(
						// SAFETY: the test layer provides IAM credentials and an emulator HTTP transport.
						IAM.deleteRolePolicy({
							RoleName: name,
							PolicyName: "send",
						}) as Effect.Effect<unknown, unknown, never>,
					);
				if (roleCreated)
					await run(
						// SAFETY: the test layer provides IAM credentials and an emulator HTTP transport.
						IAM.deleteRole({ RoleName: name }) as Effect.Effect<
							unknown,
							unknown,
							never
						>,
					);
				if (queueUrl)
					await run(
						// SAFETY: the test layer provides SQS credentials and an emulator HTTP transport.
						SQS.deleteQueue({ QueueUrl: queueUrl }) as Effect.Effect<
							unknown,
							unknown,
							never
						>,
					);
			}
		},
		110_000,
	);
});
