import { types } from "node:util";
import type { Providers } from "@alchemy.run/aws";
import { Schedule } from "@alchemy.run/aws/Scheduler";
import { Queue } from "@alchemy.run/aws/SQS";
import * as Effect from "effect/Effect";
import { awsBindleMappers } from "./aws.js";
import type {
	AlchemyPrimitiveInput,
	AlchemyPrimitiveMapper,
} from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

export interface AwsStaticScheduleOptions {
	readonly roleArn: string;
	readonly input: string;
}

/* oxlint-disable anti-slop/no-runtime-typeof, eslint/no-control-regex -- SAFETY: caller-owned schedule data and SQS message characters are validated at the provider boundary. */
function cronField(value: string | undefined, max: number): boolean {
	if (value === "*") return true;
	if (value === undefined) return false;
	const step = /^\*\/([1-9][0-9]?)$/u.exec(value);
	if (step !== null) return Number(step[1]) <= max;
	return /^(0|[1-9][0-9]?)$/u.test(value) && Number(value) <= max;
}

function awsCron(input: AlchemyPrimitiveInput<unknown, unknown>): string {
	const annotations = input.declaration.annotations;
	const annotation = annotations[0];
	const descriptor =
		annotation === undefined
			? undefined
			: Object.getOwnPropertyDescriptor(annotation.config, "cron");
	const expression =
		descriptor !== undefined && Object.hasOwn(descriptor, "value")
			? descriptor.value
			: undefined;
	if (
		annotations.length !== 1 ||
		annotation?.provider !== "hobo" ||
		annotation.option !== "cadence" ||
		typeof expression !== "string" ||
		expression.length > 100 ||
		Object.keys(annotation.config).length !== 1
	)
		throw new AlchemyIacError(
			"PRIMITIVE_UNSUPPORTED",
			"a single bounded cadence is required",
		);
	const fields = expression.split(/\s+/u);
	if (
		fields.length !== 5 ||
		!cronField(fields[0], 59) ||
		!cronField(fields[1], 23) ||
		fields[2] !== "*" ||
		!cronField(fields[3], 12) ||
		fields[3] === "0" ||
		fields[4] !== "*"
	)
		throw new AlchemyIacError(
			"PRIMITIVE_UNSUPPORTED",
			"the AWS schedule supports only UTC minute, hour and month cadences with wildcard days",
		);
	return `cron(${fields[0]} ${fields[1]} * ${fields[3]} ? *)`;
}

export function awsStaticScheduleMappers<Entrypoint, Requirements>(
	base = awsBindleMappers<Entrypoint, Requirements>(),
	options: Readonly<Record<string, AwsStaticScheduleOptions>>,
) {
	if (
		typeof options !== "object" ||
		options === null ||
		types.isProxy(options) ||
		Object.getPrototypeOf(options) !== Object.prototype ||
		Reflect.ownKeys(options).length > 256
	)
		throw new AlchemyIacError(
			"PRIMITIVE_UNSUPPORTED",
			"invalid static schedule options",
		);
	const schedules: Record<string, AwsStaticScheduleOptions> =
		Object.create(null);
	for (const name of Reflect.ownKeys(options)) {
		if (typeof name !== "string" || name.length === 0 || name.length > 200)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"invalid static schedule name",
			);
		const field = Object.getOwnPropertyDescriptor(options, name);
		const value =
			field?.enumerable && Object.hasOwn(field, "value")
				? field.value
				: undefined;
		if (
			value === null ||
			typeof value !== "object" ||
			types.isProxy(value) ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Reflect.ownKeys(value).length !== 2
		)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"invalid static schedule options",
			);
		const role = Object.getOwnPropertyDescriptor(value, "roleArn");
		const input = Object.getOwnPropertyDescriptor(value, "input");
		if (
			!role ||
			!input ||
			!role.enumerable ||
			!input.enumerable ||
			!Object.hasOwn(role, "value") ||
			!Object.hasOwn(input, "value") ||
			typeof role.value !== "string" ||
			role.value.length > 2048 ||
			!/^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/u.test(
				role.value,
			) ||
			typeof input.value !== "string" ||
			input.value.length === 0 ||
			input.value.length > 65_536 ||
			/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(
				input.value,
			) ||
			Buffer.byteLength(input.value, "utf8") > 65_536
		)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"invalid static schedule role or input",
			);
		schedules[name] = Object.freeze({
			roleArn: role.value,
			input: input.value,
		});
	}
	Object.freeze(schedules);
	const schedule: AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers> =
		{
			resourceTypes: ["AWS.Scheduler.Schedule"],
			operations: [],
			annotations: ["hobo:cadence"],
			bindsEntrypoint: false,
			limitations: [
				"Static UTC queue cadence only; the dynamic scheduler port and queue runtime are not bound. The host must authenticate the execution role and IAM scope.",
			],
			validateGraph(graph) {
				for (const name of Object.keys(schedules)) {
					if (graph.nodes[name]?.declaration.kind !== "schedule")
						throw new AlchemyIacError(
							"PRIMITIVE_UNSUPPORTED",
							"schedule options must name declared schedules",
						);
				}
			},
			validate(input) {
				awsCron(input);
				const names = Object.keys(input.dependencyDeclarations);
				if (
					names.length !== 1 ||
					names[0] === undefined ||
					input.dependencyDeclarations[names[0]]?.kind !== "queue" ||
					!Object.hasOwn(schedules, input.declaration.name)
				)
					throw new AlchemyIacError(
						"PRIMITIVE_UNSUPPORTED",
						"a configured schedule must depend on exactly one queue",
					);
			},
			build(input) {
				const name = Object.keys(input.dependencies)[0];
				const queue = name === undefined ? undefined : input.dependencies[name];
				const settings = schedules[input.declaration.name];
				if (
					name === undefined ||
					queue?.Type !== Queue.Type ||
					settings === undefined
				)
					throw new AlchemyIacError(
						"PRIMITIVE_UNSUPPORTED",
						"schedule target must be an AWS SQS queue",
					);
				// SAFETY: the resource type check above establishes the Alchemy SQS resource shape.
				const target = queue as Queue;
				return Effect.gen(function* () {
					const primary = yield* Schedule(input.declaration.name, {
						scheduleExpression: awsCron(input),
						scheduleExpressionTimezone: "UTC",
						flexibleTimeWindow: { Mode: "OFF" },
						target: {
							Arn: target.queueArn,
							RoleArn: settings.roleArn,
							Input: settings.input,
						},
					});
					return { primary, resources: [primary], boundDependencies: [name] };
				});
			},
		};
	return Object.freeze({ ...base, schedule });
}
/* oxlint-enable anti-slop/no-runtime-typeof, eslint/no-control-regex */
