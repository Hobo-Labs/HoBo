import type { CommandModule, YardRuntime } from "@hobo/cli";
import { DEFAULT_TENANT } from "@hobo/cli";
import {
	approveProviderFact,
	collectStream,
	foldRegistryStream,
	providerRegistrationFacts,
	type RegistrableProvider,
} from "@hobo/cloud";
import type { PrincipalRef } from "@hobo/core";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { installRuntime } from "./installed-runtimes.js";
import { createLocalProvider } from "./local-provider.js";
import {
	RUNTIME_INSTALL_IDS,
	type RuntimeInstallId,
	runtimeInstallIdToHost,
} from "./runtime-catalog.js";

// public-contract: provider registration and planning share this stream identifier.
export const REGISTRY_STREAM = "registry:default";

const ADD_ACTOR: PrincipalRef = { kind: "system", id: "yard/registry" };

export interface InstallableEntry {
	readonly factory: () => RegistrableProvider;
	readonly defaultHold?: boolean;
}

const INSTALLABLE = new Map<string, InstallableEntry>([
	["local", { factory: createLocalProvider }],
]);

export function registerInstallable(
	id: string,
	factory: () => RegistrableProvider,
	options: { defaultHold?: boolean } = {},
): void {
	INSTALLABLE.set(id, {
		factory,
		...(options.defaultHold !== undefined
			? { defaultHold: options.defaultHold }
			: undefined),
	});
}

export function installableProviders(): string[] {
	return [...INSTALLABLE.keys()].sort();
}

/**
 * Installable providers that advertise `port`: what `hobo up`'s ceremony
 * offers for a resource no registered provider can serve. Each catalog entry
 * is built once to read its capability ports.
 */
export function installableProvidersFor(port: string): string[] {
	const able: string[] = [];
	for (const [id, entry] of INSTALLABLE) {
		try {
			if (
				entry
					.factory()
					.capabilities.some((capability) => capability.port === port)
			)
				able.push(id);
		} catch {
			// An entry that cannot be built is not offered.
		}
	}
	return able.sort();
}

export interface AddCommandDeps {
	readonly runtime?: YardRuntime;
	readonly catalog?: Record<string, () => RegistrableProvider>;
}

export function createAddCommand(deps: AddCommandDeps = {}): CommandModule {
	return {
		run: async ({ args, flags, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo add has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "add" },
				};
			}

			const catalog: Map<string, InstallableEntry> = deps.catalog
				? new Map(
						Object.entries(deps.catalog).map(([key, factory]) => [
							key,
							{ factory },
						]),
					)
				: INSTALLABLE;
			const id = args[0];
			const available = [...catalog.keys()].sort();
			if (!id) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_ADD_NO_PROVIDER",
					message: `hobo add needs a provider: \`hobo add <provider>\`. Available: ${available.join(", ")}.`,
					remediation: [
						`Try: ${available.map((a) => `hobo add ${a}`).join(", ")}.`,
					],
					data: { command: "add", available },
				};
			}

			const entry = catalog.get(id);
			if (!entry) {
				return {
					ok: false,
					status: "unknown_provider",
					code: "HOBO_ADD_UNKNOWN",
					message: `hobo add: no installable provider "${id}". Available: ${available.join(", ")}.`,
					remediation: [`Available providers: ${available.join(", ")}.`],
					data: { command: "add", provider: id, available },
				};
			}

			const provider = entry.factory();
			const events = await collectStream(runtime.store, REGISTRY_STREAM);
			const fold = foldRegistryStream(events);
			const installed = fold.installed.has(provider.id);
			const approved = fold.approved.has(provider.id);
			const hold =
				Boolean((flags as { hold?: boolean }).hold) ||
				(!installed && entry.defaultHold === true);
			const lastSeq = events.at(-1)?.seq ?? 0;

			if (installed && approved) {
				if ((RUNTIME_INSTALL_IDS as readonly string[]).includes(id)) {
					installRuntime(
						id as RuntimeInstallId,
						process.env.HOBO_HOME ?? defaultHoboHome(),
					);
				}
				return {
					ok: true,
					status: "already_installed",
					code: "HOBO_OK",
					message: `hobo add: provider "${id}" is already installed and approved.`,
					data: { command: "add", provider: id, approved: true },
				};
			}

			if (installed && !approved && hold) {
				return {
					ok: true,
					status: "already_installed",
					code: "HOBO_OK",
					message: `hobo add: provider "${id}" is already installed (held — run \`hobo add ${id}\` to approve).`,
					data: { command: "add", provider: id, approved: false },
				};
			}

			if (installed && !approved) {
				await runtime.store.append(
					REGISTRY_STREAM,
					[approveProviderFact(provider.id, ADD_ACTOR.id)],
					{ expectedSeq: lastSeq, actor: ADD_ACTOR, tenant: DEFAULT_TENANT },
				);
				await runtime.registry.refresh?.();
				emitProgress(`approved ${id}`);
				return {
					ok: true,
					status: "approved",
					code: "HOBO_OK",
					message: `hobo add: approved provider "${id}" — it is now matchable.`,
					data: { command: "add", provider: id, approved: true },
				};
			}

			const facts = providerRegistrationFacts(provider);
			if (!hold) facts.push(approveProviderFact(provider.id, ADD_ACTOR.id));
			await runtime.store.append(REGISTRY_STREAM, facts, {
				expectedSeq: lastSeq,
				actor: ADD_ACTOR,
				tenant: DEFAULT_TENANT,
			});
			await runtime.registry.refresh?.();
			const ports = provider.capabilities.map((c) => c.port).sort();

			let runtimeHost: string | undefined;
			if ((RUNTIME_INSTALL_IDS as readonly string[]).includes(id) && !hold) {
				const installed = installRuntime(
					id as RuntimeInstallId,
					process.env.HOBO_HOME ?? defaultHoboHome(),
				);
				runtimeHost = runtimeInstallIdToHost(id);
				emitProgress(
					`enabled camp host runtime ${id} (hosts: ${installed.runtimes.join(", ")})`,
				);
			}

			emitProgress(
				`installed ${id}: ${ports.join(", ")}${hold ? " (held)" : ""}`,
			);

			return {
				ok: true,
				status: "installed",
				code: "HOBO_OK",
				message: hold
					? `hobo add: installed provider "${id}" (${ports.join(", ")}) — held; run \`hobo add ${id}\` to approve.`
					: runtimeHost
						? `hobo add: installed runtime "${id}" (componentHost=${runtimeHost}). Run \`hobo yard ensure\` to equip toolchains.`
						: `hobo add: installed provider "${id}" (${ports.join(", ")}).`,
				data: {
					command: "add",
					provider: id,
					ports,
					regions: [...provider.regions],
					approved: !hold,
					...(runtimeHost !== undefined
						? { componentHost: runtimeHost }
						: undefined),
				},
			};
		},
	};
}
