import type { CommandModule, YardRuntime } from "@hobo/cli";
import { DEFAULT_TENANT } from "@hobo/cli";
import {
	collectStream,
	registerProviderFact,
	registryCatalogProjection,
} from "@hobo/cloud";
import type { PrincipalRef } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import { REGISTRY_STREAM } from "./add-command.js";
import { createProviderFromPorts } from "./local-provider.js";

export interface GenerateCommandDeps {
	// The shared Yard runtime whose registry stream the generated provider lands in.
	readonly runtime?: YardRuntime;
}

const GENERATE_ACTOR: PrincipalRef = { kind: "user", id: "user:generator" };

const DEFAULT_PORTS = ["kv"];

// `hobo generate <name> [ports...]` — request provider generation. It
// synthesizes a real Capability-Manifest-bearing provider from a port spec
// (`createProviderFromPorts`) and registers it into the catalog via a durable
// `provider.Registered` fact, so `hobo registry` and the Planner immediately see
// the generated provider. Reads/writes only the local event store; no cloud
// call, no credential. HONEST SCOPE: deterministic generation from the declared
// port spec; AI-assisted provider synthesis is a follow-up.
export function createGenerateCommand(
	deps: GenerateCommandDeps = {},
): CommandModule {
	return {
		run: async ({ args, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo generate has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "generate" },
				};
			}

			const name = args[0];
			if (!name) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_GENERATE_NO_NAME",
					message:
						"hobo generate needs a provider name: `hobo generate <name> [ports...]`.",
					remediation: ["Example: `hobo generate my-provider kv objectStore`."],
					data: { command: "generate" },
				};
			}

			const ports =
				args.length > 1 ? [...new Set(args.slice(1))] : DEFAULT_PORTS;
			const provider = createProviderFromPorts(name, ports);

			const events = await collectStream(runtime.store, REGISTRY_STREAM);
			const existing = registryCatalogProjection.query(
				registryCatalogProjection.fold(events),
			);
			if (existing.some((row) => row.providerId === name)) {
				return {
					ok: false,
					status: "exists",
					code: "HOBO_GENERATE_EXISTS",
					message: `hobo generate: a provider named "${name}" is already registered.`,
					remediation: ["Choose a different name or remove the existing one."],
					data: { command: "generate", provider: name },
				};
			}

			const fact = registerProviderFact(provider);
			const lastSeq =
				events.length > 0 ? must(events[events.length - 1]).seq : 0;
			await runtime.store.append(REGISTRY_STREAM, [fact], {
				expectedSeq: lastSeq,
				actor: GENERATE_ACTOR,
				tenant: DEFAULT_TENANT,
			});
			emitProgress(`generated ${name}: ${ports.join(", ")}`);

			return {
				ok: true,
				status: "generated",
				code: "HOBO_OK",
				message: `hobo generate: generated + registered provider "${name}" (${ports.join(", ")}).`,
				data: {
					command: "generate",
					provider: name,
					ports,
					manifest: provider.capabilityManifest(),
				},
			};
		},
	};
}
