import type { Providers } from "@alchemy.run/aws";
import { Topic } from "@alchemy.run/aws/SNS";
import * as Effect from "effect/Effect";
import { awsBindleMappers } from "./aws.js";
import { withAwsTargetSelection } from "./aws-target-selection.js";
import type { AlchemyPrimitiveMapper, BindleForAlchemy } from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

const keys = Object.keys;
const descriptors = Object.getOwnPropertyDescriptors;
const freeze = Object.freeze;

export function awsSnsNotification() {
	return freeze({
		provider: "aws",
		option: "sns-notification",
		config: freeze({
			runtime: "node-js",
			maxBodyBytes: 65_536,
			retries: "none",
		}),
	});
}

export function withAwsSnsNotification<Entrypoint, Requirements>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	choices: Readonly<Record<string, true>>,
): BindleForAlchemy<Entrypoint, Requirements> {
	return withAwsTargetSelection(
		bindle,
		choices,
		"notify",
		"Notification",
		awsSnsNotification(),
	);
}

export function awsSnsNotificationMappers<Entrypoint, Requirements>(
	base = awsBindleMappers<Entrypoint, Requirements>(),
) {
	const notify: AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers> = {
		resourceTypes: ["AWS.SNS.Topic"],
		operations: ["send"],
		annotations: ["aws:sns-notification"],
		bindsEntrypoint: false,
		limitations: [
			"Node.js SNS sends have no automatic retry or delivery guarantee; subscriptions, recipients and application bindings are host-managed.",
			"The host must authorize the exact topic grant and reconcile unknown submissions before retrying.",
			"Supplied pricing must cover topic and publish charges; individual sends do not perform budget admission.",
		],
		validate(input) {
			if (keys(input.dependencyDeclarations).length !== 0)
				throw new AlchemyIacError(
					"BINDLE_GRAPH_UNSUPPORTED",
					"SNS notification dependencies are not bound",
				);
			const annotations = input.declaration.annotations;
			const annotation = annotations[0];
			const fields =
				annotation === undefined ? {} : descriptors(annotation.config);
			if (
				annotations.length !== 1 ||
				annotation?.provider !== "aws" ||
				annotation.option !== "sns-notification" ||
				keys(fields).length !== 3 ||
				fields.runtime?.value !== "node-js" ||
				fields.maxBodyBytes?.value !== 65_536 ||
				fields.retries?.value !== "none"
			)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"SNS notification requires the explicit bounded runtime choice",
				);
		},
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* Topic(input.declaration.name, {});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	return freeze({ ...base, notify });
}
