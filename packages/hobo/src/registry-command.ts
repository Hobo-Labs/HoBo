import type { CommandModule, YardRuntime } from "@hobo/cli";
import {
	collectStream,
	foldRegistryStream,
	registryCatalogProjection,
} from "@hobo/cloud";

import { REGISTRY_STREAM } from "./add-command.js";
import { runRegistryAdd } from "./registry-add.js";

export interface RegistryCommandDeps {
	// The shared Yard runtime whose PlannerRegistry (the provider + capability
	// catalog the Planner matches against) this command lists.
	readonly runtime?: YardRuntime;
}

interface RegistryPort {
	readonly port: string;
	readonly definitions: number;
	readonly features: string[];
	readonly regions: string[];
}

interface RegistryProvider {
	readonly providerId: string;
	readonly ports: RegistryPort[];
	// "base" = built into the runtime; "installed" = added via `hobo add`.
	readonly source: "base" | "installed";
	// Only approved providers are matchable (walkthrough Part 0/2); a held
	// (installed-but-unapproved) provider renders approved: false.
	readonly approved: boolean;
}

// `hobo registry` — administer registry artifacts. This read view lists the
// live provider + capability catalog the Planner matches deployments against:
// the content-addressed catalog hash, the registered providers, and the ports
// (with features/regions) each offers. It reads the injected PlannerRegistry
// directly — no cloud call, no credential.
//
// `hobo registry add <manifest>` registers a provider described by a
// hobo.provider-manifest/v1 data file (see ./registry-add.ts).
export function createRegistryCommand(
	deps: RegistryCommandDeps = {},
): CommandModule {
	return {
		run: async ({ args, context, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo registry has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "registry" },
				};
			}

			if (args[0] === "add") {
				return runRegistryAdd({
					runtime,
					file: args[1],
					cwd: context.cwd,
					emitProgress,
				});
			}

			const registry = runtime.registry;
			const definitions = registry.definitions();

			// Group definitions by provider, then by port.
			const byProvider = new Map<string, Map<string, RegistryPort>>();
			for (const def of definitions) {
				let ports = byProvider.get(def.providerId);
				if (!ports) {
					ports = new Map();
					byProvider.set(def.providerId, ports);
				}
				const existing = ports.get(def.port);
				if (existing) {
					ports.set(def.port, {
						port: def.port,
						definitions: existing.definitions + 1,
						features: [...new Set([...existing.features, ...def.features])],
						regions: [...new Set([...existing.regions, ...def.regions])],
					});
				} else {
					ports.set(def.port, {
						port: def.port,
						definitions: 1,
						features: [...def.features],
						regions: [...def.regions],
					});
				}
			}

			// Providers installed via `hobo add` — folded from the durable registry
			// stream. Anything the stream knows about is "installed"; the rest of
			// the live PlannerRegistry snapshot is "base" (compiled into the
			// runtime). One projection, one fold — no second source of truth.
			const registryEvents = await collectStream(
				runtime.store,
				REGISTRY_STREAM,
			);
			const installedRows = registryCatalogProjection.query(
				registryCatalogProjection.fold(registryEvents),
			);
			const approvedSet = foldRegistryStream(registryEvents).approved;
			const installedIds = new Set(installedRows.map((row) => row.providerId));

			const providers: RegistryProvider[] = registry
				.providers()
				.filter((providerId) => !installedIds.has(providerId))
				.sort()
				.map((providerId) => ({
					providerId,
					ports: [...(byProvider.get(providerId)?.values() ?? [])].sort(
						(a, b) => a.port.localeCompare(b.port),
					),
					source: "base" as const,
					approved: true,
				}));

			const installed: RegistryProvider[] = installedRows
				.map((row) => ({
					providerId: row.providerId,
					ports: [...row.ports].sort().map((port) => ({
						port,
						definitions: 1,
						features: [],
						regions: [],
					})),
					source: "installed" as const,
					approved: approvedSet.has(row.providerId),
				}))
				.sort((a, b) => a.providerId.localeCompare(b.providerId));

			const allProviders = [...providers, ...installed];
			const definitionCount =
				providers.reduce(
					(n, row) => n + row.ports.reduce((m, p) => m + p.definitions, 0),
					0,
				) + installedRows.reduce((n, row) => n + row.definitionCount, 0);

			for (const provider of allProviders) {
				emitProgress(
					`${provider.providerId} (${provider.source}${provider.approved ? "" : " · held"}): ${provider.ports.map((p) => p.port).join(", ")}`,
				);
			}

			return {
				ok: true,
				status: "ok",
				code: "HOBO_OK",
				message: `hobo registry: ${allProviders.length} provider(s) (${installed.length} installed), ${definitionCount} definition(s) (catalog ${registry.catalogHash})`,
				data: {
					command: "registry",
					catalogHash: registry.catalogHash,
					providers: allProviders,
					definitionCount,
				},
			};
		},
	};
}
