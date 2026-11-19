import type { CommandModule } from "@hobo/cli";
import {
	createKafkaProvider,
	diagnoseKafkaReadiness,
	localRedpandaCluster,
} from "@hobo/provider-kafka";
import {
	createDaprRuntimeHost,
	diagnoseDaprReadiness,
} from "@hobo/runtime-dapr";
import { cloneAsJson, isJsonString } from "./json.js";

export interface MessagingCommandDeps {
	readonly env?: Record<string, string | undefined>;
	readonly tenantId?: string;
	readonly campId?: string;
}

export function createMessagingCommand(
	deps: MessagingCommandDeps = {},
): CommandModule {
	return {
		run: async ({ args, emitProgress }) => {
			const env = deps.env ?? process.env;
			const sub = args[0] ?? "status";
			const tenantId =
				deps.tenantId ??
				(isJsonString(env.HOBO_TENANT) && env.HOBO_TENANT
					? env.HOBO_TENANT
					: "local");
			const campId =
				deps.campId ??
				(isJsonString(env.HOBO_CAMP) && env.HOBO_CAMP
					? env.HOBO_CAMP
					: "default");

			const kafka = diagnoseKafkaReadiness({ env });
			const dapr = diagnoseDaprReadiness({ env });
			const provider = createKafkaProvider({ tenantId });
			const daprBundle = createDaprRuntimeHost({ tenantId, campId });

			if (sub === "component-yaml" || sub === "dry-run-yaml") {
				const binding =
					args[1] ??
					(isJsonString(env.HOBO_KAFKA_BOOTSTRAP_BINDING)
						? env.HOBO_KAFKA_BOOTSTRAP_BINDING
						: "fromBinding:kafka-bootstrap");
				const yaml = daprBundle.generateKafkaPubsubYaml(binding);
				emitProgress(
					`hobo messaging component-yaml: secretless pubsub.kafka for appId=${daprBundle.config.appId}`,
				);
				return {
					ok: true,
					status: "generated",
					code: "HOBO_MESSAGING_COMPONENT_YAML",
					message: "Generated Dapr component YAML (secretless metadata)",
					data: {
						command: "messaging",
						subcommand: "component-yaml",
						yaml,
						secretless: true,
						appId: daprBundle.config.appId,
					},
				};
			}

			if (sub === "realize") {
				const realized = provider.realize({
					cluster: cloneAsJson(localRedpandaCluster(tenantId)),
					topics: [
						{
							name: args[1] ?? "events",
							partitions: 3,
							replicationFactor: 1,
							deliveryGuarantee: "at-least-once",
						},
					],
				});
				emitProgress(
					`hobo messaging realize: backend=${realized.messagingBackend} topics=${realized.topics.length}`,
				);
				return {
					ok: true,
					status: "planned",
					code: "HOBO_MESSAGING_REALIZE",
					message: "Kafka resources realized (plan-time, secretless)",
					data: {
						command: "messaging",
						subcommand: "realize",
						realized,
					},
				};
			}

			emitProgress(
				`hobo messaging status: kafka=${kafka.fidelity} dapr=${dapr.fidelity} default=in-process-wasm`,
			);
			return {
				ok: true,
				status: "ok",
				code: "HOBO_MESSAGING_STATUS",
				message:
					"Messaging plane: native Kafka + optional Dapr; app ports wasi:messaging / topic()",
				data: {
					command: "messaging",
					subcommand: "status",
					wit: "wasi:messaging/messaging@0.2.0",
					defaultRuntime: "in-process-wasm",
					daprOptional: true,
					kafka,
					dapr,
					campAppId: daprBundle.config.appId,
					providerId: provider.id,
					adr: "ADR-0138",
				},
			};
		},
	};
}
