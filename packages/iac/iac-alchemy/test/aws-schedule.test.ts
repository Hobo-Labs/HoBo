import { Schedule } from "@alchemy.run/aws/Scheduler";
import { Queue } from "@alchemy.run/aws/SQS";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { cadence } from "../../../bindles/src/cadence.js";
import { awsBindleMappers } from "../src/aws.js";
import { awsStaticScheduleMappers } from "../src/aws-schedule.js";
import {
	describeAlchemyPrimitiveSupport,
	mapBindleToAlchemy,
} from "../src/bindle.js";

const requirements = {
	assessRequirements: () => ({ status: "supported" as const }),
};
const roleArn = "arn:aws:iam::123456789012:role/scheduler-send";
const stack = {
	name: "Shop",
	stage: "test",
	resources: {},
	bindings: {},
	actions: {},
};

describe("static AWS queue schedules", () => {
	it("reports static schedule support as partial", () => {
		const mappers = awsStaticScheduleMappers(awsBindleMappers(), {});
		const [support] = describeAlchemyPrimitiveSupport(
			[{ factory: "schedule", allowVerbs: [] }],
			mappers,
		);
		expect(support).toMatchObject({
			status: "partial",
			resourceTypes: [Schedule.Type],
			bindsEntrypoint: false,
		});
		expect(support?.limitations[0]).toContain("dynamic scheduler port");
	});
	it("maps a cadence and its declared queue to Alchemy Scheduler and SQS", async () => {
		const app = bindle("shop", (b) => {
			const queue = b.queue();
			return {
				queue,
				tick: b.schedule().dependsOn(queue).with(cadence("*/15 * * * *")),
			};
		});
		const mappers = awsStaticScheduleMappers(awsBindleMappers(), {
			tick: { roleArn, input: '{"kind":"repair"}' },
		});
		// SAFETY: this test only registers resources in an isolated Alchemy stack.
		const mapped = await Effect.runPromise(
			mapBindleToAlchemy(app, mappers, requirements).pipe(
				Effect.provideService(StackContext, stack),
			) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
		);
		expect(mapped.primary.queue?.Type).toBe(Queue.Type);
		expect(mapped.primary.tick?.Type).toBe(Schedule.Type);
		expect(mapped.resources.map((resource) => resource.Type).sort()).toEqual(
			[Queue.Type, Schedule.Type].sort(),
		);
		expect(mapped.primary.tick?.Props).toMatchObject({
			scheduleExpression: "cron(*/15 * * * ? *)",
			scheduleExpressionTimezone: "UTC",
			flexibleTimeWindow: { Mode: "OFF" },
			target: { RoleArn: roleArn, Input: '{"kind":"repair"}' },
		});
	});

	it.each([
		"* * 1 * *",
		"* * * * MON",
		"60 * * * *",
		"*/0 * * * *",
	])("rejects an unsupported cadence before registering resources: %s", (expression) => {
		const app = bindle("shop", (b) => {
			const queue = b.queue();
			return {
				queue,
				tick: b.schedule().dependsOn(queue).with(cadence(expression)),
			};
		});
		expect(() =>
			mapBindleToAlchemy(
				app,
				awsStaticScheduleMappers(awsBindleMappers(), {
					tick: { roleArn, input: "tick" },
				}),
				requirements,
			),
		).toThrow("PRIMITIVE_UNSUPPORTED");
	});

	it("rejects missing schedule options and invalid role identifiers", () => {
		const app = bindle("shop", (b) => {
			const queue = b.queue();
			return {
				queue,
				tick: b.schedule().dependsOn(queue).with(cadence("* * * * *")),
			};
		});
		expect(() =>
			mapBindleToAlchemy(
				app,
				awsStaticScheduleMappers(awsBindleMappers(), {}),
				requirements,
			),
		).toThrow("PRIMITIVE_UNSUPPORTED");
		expect(() =>
			awsStaticScheduleMappers(awsBindleMappers(), {
				tick: { roleArn: "not-an-arn", input: "tick" },
			}),
		).toThrow();
	});

	it("rejects options for absent schedules and a non-queue target", () => {
		const app = bindle("shop", (b) => {
			const storage = b.kv();
			return {
				storage,
				tick: b.schedule().dependsOn(storage).with(cadence("* * * * *")),
			};
		});
		expect(() =>
			mapBindleToAlchemy(
				app,
				awsStaticScheduleMappers(awsBindleMappers(), {
					tick: { roleArn, input: "tick" },
				}),
				requirements,
			),
		).toThrow("PRIMITIVE_UNSUPPORTED");
		expect(() =>
			mapBindleToAlchemy(
				app,
				awsStaticScheduleMappers(awsBindleMappers(), {
					tick: { roleArn, input: "tick" },
					other: { roleArn, input: "tick" },
				}),
				requirements,
			),
		).toThrow("PRIMITIVE_UNSUPPORTED");
	});

	it.each([
		"",
		"\u0000",
		"\ud800",
		"a".repeat(65_537),
	])("rejects invalid queue message bodies", (input) => {
		expect(() =>
			awsStaticScheduleMappers(awsBindleMappers(), {
				tick: { roleArn, input },
			}),
		).toThrow();
	});

	it("rejects accessor-backed configuration without invoking it", () => {
		let reads = 0;
		const settings = Object.defineProperty({}, "tick", {
			enumerable: true,
			get() {
				reads++;
				return { roleArn, input: "tick" };
			},
		});
		expect(() =>
			awsStaticScheduleMappers(awsBindleMappers(), settings),
		).toThrow();
		expect(reads).toBe(0);
	});
});
