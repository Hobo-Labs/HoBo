import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandResult, YardRuntime } from "@hobo/cli";
import { DEFAULT_TENANT } from "@hobo/cli";
import {
	approveProviderFact,
	collectStream,
	foldRegistryStream,
	registerProviderFact,
	registryCatalogProjection,
} from "@hobo/cloud";
import type { JsonValue, PrincipalRef } from "@hobo/core";
import {
	parseProviderManifest,
	providerFromManifest,
	resolveAuthFlows,
	toPricingCatalog,
} from "@hobo/provider-manifest";

import { REGISTRY_STREAM } from "./add-command.js";
import { isJsonObject, isJsonString } from "./json.js";
import {
	catalogRegisteredFact,
	storedCatalogs,
} from "./pricing-catalog-store.js";

const REGISTRY_ACTOR: PrincipalRef = { kind: "system", id: "yard/registry" };

const MANIFEST_SOURCE = "provider-manifest/v1";

function registrationSource(
	events: readonly { readonly type: string; readonly data: unknown }[],
	providerId: string,
): string | undefined {
	let source: string | undefined;
	for (const event of events) {
		// SAFETY: the event store persists JSON; the guards below refine it.
		const data = event.data as JsonValue;
		if (
			event.type === "provider.Registered" &&
			isJsonObject(data) &&
			data.providerId === providerId
		) {
			source = isJsonString(data.source) ? data.source : undefined;
		}
	}
	return source;
}

export interface RegistryAddInput {
	readonly runtime: YardRuntime;
	readonly file: string | undefined;
	readonly cwd: string;
	readonly emitProgress: (line: string) => void;
	readonly now?: () => string;
}

export async function runRegistryAdd(
	input: RegistryAddInput,
): Promise<CommandResult> {
	const { runtime, file, emitProgress } = input;
	if (file === undefined) {
		return {
			ok: false,
			status: "usage",
			code: "HOBO_REGISTRY_ADD_NO_MANIFEST",
			message:
				"hobo registry add needs a provider manifest: `hobo registry add <manifest.yaml>`.",
			remediation: [
				"Write a hobo.provider-manifest/v1 document (see docs/design/provider-manifest.md).",
			],
			data: { command: "registry add" },
		};
	}

	const path = resolve(input.cwd, file);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return {
			ok: false,
			status: "unreadable",
			code: "HOBO_REGISTRY_ADD_UNREADABLE",
			message: `hobo registry add: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
			data: { command: "registry add", file },
		};
	}

	const parsed = parseProviderManifest(
		text,
		path.endsWith(".json") ? "json" : "yaml",
	);
	if (!parsed.ok) {
		return {
			ok: false,
			status: "invalid_manifest",
			code: "HOBO_REGISTRY_ADD_INVALID",
			message: `hobo registry add: ${file} is not a valid provider manifest (${parsed.issues.length} issue(s)).`,
			remediation: parsed.issues.map((issue) =>
				issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`,
			),
			data: { command: "registry add", file, issues: [...parsed.issues] },
		};
	}

	const provider = providerFromManifest(parsed.manifest);
	if (provider.capabilities.length === 0) {
		return {
			ok: false,
			status: "nothing_to_register",
			code: "HOBO_REGISTRY_ADD_NO_CAPABILITIES",
			message: `hobo registry add: ${file} declares no capability mappings, so there is nothing for the Planner to match.`,
			remediation: [
				"Add a capabilities.mappings entry, or use `hobo-provider-manifest generate` for API clients only.",
			],
			data: { command: "registry add", file, provider: provider.id },
		};
	}

	const events = await collectStream(runtime.store, REGISTRY_STREAM);
	const fold = foldRegistryStream(events);
	const installed = fold.installed.has(provider.id);
	const approved = fold.approved.has(provider.id);
	const builtIn =
		!installed && runtime.registry.providers().includes(provider.id);
	const installedElsewhere =
		installed && registrationSource(events, provider.id) !== MANIFEST_SOURCE;
	if (builtIn || installedElsewhere) {
		return {
			ok: false,
			status: "conflict",
			code: "HOBO_REGISTRY_ADD_CONFLICT",
			message: builtIn
				? `hobo registry add: provider id "${provider.id}" belongs to a built-in provider.`
				: `hobo registry add: provider id "${provider.id}" is already installed by another route (hobo add or hobo generate); a manifest cannot replace it.`,
			remediation: ["Choose a different provider.id in the manifest."],
			data: { command: "registry add", file, provider: provider.id },
		};
	}

	const ports = provider.capabilities.map((capability) => capability.port);
	const billing = toPricingCatalog(parsed.manifest);
	const data = {
		command: "registry add",
		file,
		provider: provider.id,
		ports,
		regions: [...provider.regions],
		authFlows: resolveAuthFlows(parsed.manifest).map((flow) => flow.type),
		shadowedMappings: [...provider.shadowedMappings],
		unratedPlans: (billing?.unrated ?? []).map(
			(plan) => `${plan.productId}/${plan.planId}`,
		),
		...(billing === undefined
			? undefined
			: { pricingCatalogHash: billing.catalog.catalogHash }),
	};

	const stored = storedCatalogs(events).get(provider.id);
	const catalogStatus: "none" | "unchanged" | "added" | "updated" =
		billing === undefined
			? "none"
			: stored === undefined
				? "added"
				: stored.catalogHash === billing.catalog.catalogHash
					? "unchanged"
					: "updated";
	const catalogFacts =
		billing !== undefined &&
		(catalogStatus === "added" || catalogStatus === "updated")
			? [
					catalogRegisteredFact(
						provider.id,
						billing.catalog,
						(input.now ?? (() => new Date().toISOString()))(),
					),
				]
			: [];
	const base = registerProviderFact(provider);
	const registered = {
		...base,
		// SAFETY: registerProviderFact builds an object body; the stamp is added.
		data: { ...(base.data as object), source: MANIFEST_SOURCE },
	};
	const storedRow = registryCatalogProjection
		.query(registryCatalogProjection.fold(events))
		.find((row) => row.providerId === provider.id);
	// SAFETY: registerProviderFact builds this body with a manifestIndexDigest.
	const newDigest = (base.data as { manifestIndexDigest: string })
		.manifestIndexDigest;
	const registrationChanged =
		installed && storedRow?.manifestIndexDigest !== newDigest;
	const refreshFacts = [
		...(registrationChanged ? [registered] : []),
		...catalogFacts,
	];
	const pricingCatalog = {
		persisted: billing !== undefined,
		appended: catalogFacts.length > 0,
		status: catalogStatus,
		previousHash: stored?.catalogHash,
	};
	const registration = { refreshed: registrationChanged };
	const lastSeq = events.at(-1)?.seq ?? 0;
	const append = {
		expectedSeq: lastSeq,
		actor: REGISTRY_ACTOR,
		tenant: DEFAULT_TENANT,
	};

	if (installed && approved) {
		if (refreshFacts.length === 0) {
			return {
				ok: true,
				status: "already_installed",
				code: "HOBO_OK",
				message: `hobo registry add: provider "${provider.id}" is already registered and approved, and ${file} matches what is stored.`,
				data: { ...data, approved: true, pricingCatalog, registration },
			};
		}
		await runtime.store.append(REGISTRY_STREAM, refreshFacts, append);
		await runtime.registry.refresh?.();
		const what = [
			...(catalogStatus === "updated"
				? [
						`pricing catalog ${stored?.catalogHash} -> ${billing?.catalog.catalogHash}`,
					]
				: []),
			...(catalogStatus === "added" ? ["pricing catalog stored"] : []),
			...(registrationChanged ? ["registration refreshed"] : []),
		];
		emitProgress(`updated ${provider.id}: ${what.join("; ")}`);
		return {
			ok: true,
			status: "updated",
			code: "HOBO_OK",
			message: `hobo registry add: updated provider "${provider.id}" from ${file} (${what.join("; ")}). It stays approved; the Planner ranks on the new facts from now on.`,
			data: { ...data, approved: true, pricingCatalog, registration },
		};
	}

	if (installed) {
		await runtime.store.append(
			REGISTRY_STREAM,
			[approveProviderFact(provider.id, REGISTRY_ACTOR.id), ...refreshFacts],
			append,
		);
		await runtime.registry.refresh?.();
		emitProgress(`approved ${provider.id}`);
		return {
			ok: true,
			status: "approved",
			code: "HOBO_OK",
			message: `hobo registry add: approved provider "${provider.id}" — it is now matchable. It was registered from a manifest, which declares capabilities but cannot provision them.`,
			data: { ...data, approved: true, pricingCatalog, registration },
		};
	}

	await runtime.store.append(
		REGISTRY_STREAM,
		[registered, ...catalogFacts],
		append,
	);
	await runtime.registry.refresh?.();
	for (const mapping of provider.shadowedMappings) {
		emitProgress(
			`skipped mapping ${mapping}: an earlier mapping already claims its port`,
		);
	}
	emitProgress(`registered ${provider.id}: ${ports.join(", ")} (held)`);
	return {
		ok: true,
		status: "installed",
		code: "HOBO_OK",
		message: `hobo registry add: registered provider "${provider.id}" (${ports.join(", ")}) — held; run \`hobo registry add ${file}\` again to approve it for matching.`,
		data: { ...data, approved: false, pricingCatalog, registration },
	};
}
