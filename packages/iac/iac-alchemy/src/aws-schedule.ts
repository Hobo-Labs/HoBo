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

const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const descriptorOf = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const getPrototype = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const keysOf = Object.keys;
const freeze = Object.freeze;
const create = Object.create;
const objectPrototype = Object.prototype;
const isProxy = types.isProxy;
const execRegex = RegExp.prototype.exec;
const stringIncludes = String.prototype.includes;
const stringSlice = String.prototype.slice;
const byteLength = Buffer.byteLength;
const parseNumber = Number;

export interface AwsStaticScheduleOptions {
	readonly roleArn: string;
	readonly input: string;
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply, eslint/no-control-regex -- SAFETY: caller-owned data is validated using captured intrinsics before registration. */
function cronField(value: string | undefined, max: number): boolean {
	if (value === "*") return true;
	if (value === undefined) return false;
	const step = apply(execRegex, /^\*\/([1-9][0-9]?)$/u, [value]);
	if (step !== null) return parseNumber(step[1]) <= max;
	return (
		apply(execRegex, /^(0|[1-9][0-9]?)$/u, [value]) !== null &&
		parseNumber(value) <= max
	);
}

function awsCron(input: AlchemyPrimitiveInput<unknown, unknown>): string {
	const annotations = input.declaration.annotations;
	const annotation = annotations[0];
	const descriptor =
		annotation === undefined
			? undefined
			: descriptorOf(annotation.config, "cron");
	const expression =
		descriptor !== undefined && hasOwn(descriptor, "value")
			? descriptor.value
			: undefined;
	if (
		annotations.length !== 1 ||
		annotation?.provider !== "hobo" ||
		annotation.option !== "cadence" ||
		typeof expression !== "string" ||
		expression.length > 100 ||
		keysOf(annotation.config).length !== 1
	)
		throw new AlchemyIacError(
			"PRIMITIVE_UNSUPPORTED",
			"a single bounded cadence is required",
		);
	const fields: string[] = [];
	let start = 0;
	for (let index = 0; index <= expression.length; index++) {
		const character = expression[index];
		if (
			character === undefined ||
			apply(execRegex, /\s/u, [character]) !== null
		) {
			if (index > start)
				defineProperty(fields, fields.length, {
					value: apply(stringSlice, expression, [start, index]),
					enumerable: true,
					writable: true,
					configurable: true,
				});
			start = index + 1;
		}
	}
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
	if (typeof base !== "object" || base === null || isProxy(base))
		throw new AlchemyIacError(
			"PRIMITIVE_UNSUPPORTED",
			"invalid AWS mapper set",
		);
	const basePrototype = getPrototype(base);
	const baseNames = ownKeys(base);
	if (
		(basePrototype !== objectPrototype && basePrototype !== null) ||
		baseNames.length > 256
	)
		throw new AlchemyIacError(
			"PRIMITIVE_UNSUPPORTED",
			"invalid AWS mapper set",
		);
	const merged = create(null);
	for (let index = 0; index < baseNames.length; index++) {
		const name = baseNames[index];
		if (typeof name !== "string" || name === "schedule")
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"invalid AWS mapper name",
			);
		const field = descriptorOf(base, name);
		if (!field || !field.enumerable || !hasOwn(field, "value"))
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"AWS mappers must be own data",
			);
		defineProperty(merged, name, {
			value: field.value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	if (
		typeof options !== "object" ||
		options === null ||
		isProxy(options) ||
		getPrototype(options) !== objectPrototype ||
		ownKeys(options).length > 256
	)
		throw new AlchemyIacError(
			"PRIMITIVE_UNSUPPORTED",
			"invalid static schedule options",
		);
	const schedules: Record<string, AwsStaticScheduleOptions> = create(null);
	const optionNames = ownKeys(options);
	for (let index = 0; index < optionNames.length; index++) {
		const name = optionNames[index];
		if (typeof name !== "string" || name.length === 0 || name.length > 200)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"invalid static schedule name",
			);
		const field = descriptorOf(options, name);
		const value =
			field?.enumerable && hasOwn(field, "value") ? field.value : undefined;
		if (
			value === null ||
			typeof value !== "object" ||
			isProxy(value) ||
			getPrototype(value) !== objectPrototype ||
			ownKeys(value).length !== 2
		)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"invalid static schedule options",
			);
		const role = descriptorOf(value, "roleArn");
		const input = descriptorOf(value, "input");
		if (
			!role ||
			!input ||
			!role.enumerable ||
			!input.enumerable ||
			!hasOwn(role, "value") ||
			!hasOwn(input, "value") ||
			typeof role.value !== "string" ||
			role.value.length > 2048 ||
			apply(
				execRegex,
				/^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/u,
				[role.value],
			) === null ||
			typeof input.value !== "string" ||
			input.value.length === 0 ||
			input.value.length > 65_536 ||
			apply(
				execRegex,
				/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u,
				[input.value],
			) !== null ||
			apply(stringIncludes, input.value, ["<aws.scheduler."]) ||
			byteLength(input.value, "utf8") > 65_536
		)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"invalid static schedule role or input",
			);
		schedules[name] = freeze({
			roleArn: role.value,
			input: input.value,
		});
	}
	freeze(schedules);
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
				const names = keysOf(schedules);
				for (let index = 0; index < names.length; index++) {
					const name = names[index];
					if (name === undefined)
						throw new AlchemyIacError(
							"PRIMITIVE_UNSUPPORTED",
							"schedule name is unavailable",
						);
					if (graph.nodes[name]?.declaration.kind !== "schedule")
						throw new AlchemyIacError(
							"PRIMITIVE_UNSUPPORTED",
							"schedule options must name declared schedules",
						);
				}
			},
			validate(input) {
				awsCron(input);
				const names = keysOf(input.dependencyDeclarations);
				if (
					names.length !== 1 ||
					names[0] === undefined ||
					input.dependencyDeclarations[names[0]]?.kind !== "queue" ||
					!hasOwn(schedules, input.declaration.name)
				)
					throw new AlchemyIacError(
						"PRIMITIVE_UNSUPPORTED",
						"a configured schedule must depend on exactly one queue",
					);
			},
			build(input) {
				const name = keysOf(input.dependencies)[0];
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
	defineProperty(merged, "schedule", {
		value: schedule,
		enumerable: true,
		configurable: true,
		writable: true,
	});
	// SAFETY: every base field was copied as own data and schedule is the checked mapper above.
	return freeze(merged) as typeof base & { readonly schedule: typeof schedule };
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply, eslint/no-control-regex */
