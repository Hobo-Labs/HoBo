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
import type { PrincipalRef } from "@hobo/core";
import {
	parseProviderManifest,
	providerFromManifest,
	resolveAuthFlows,
	toPricingCatalog,
} from "@hobo/provider-manifest";

import { REGISTRY_STREAM } from "./add-command.js";
import {
	catalogRegisteredFact,
	storedCatalogs,
} from "./pricing-catalog-store.js";

const REGISTRY_ACTOR: PrincipalRef = { kind: "system", id: "yard/registry" };

export interface RegistryAddInput {
	readonly runtime: YardRuntime;
	/** Manifest path as typed; resolved against `cwd`. */
	readonly file: string | undefined;
	readonly cwd: string;
	readonly emitProgress: (line: string) => void;
	/** UTC timestamp for facts this command appends. Defaults to the wall clock. */
	readonly now?: () => string;
}

// `hobo registry add <manifest>` — register a provider described by a data
// file (`hobo.provider-manifest/v1`) instead of a provider package.
//
// A manifest declares; it cannot realize. So the first run registers the
// provider HELD — visible in `hobo registry`, never matched — and running the
// command again is the explicit approval, the same two-step posture
// `hobo add` uses for deploy targets that need a deliberate decision.
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
		// Refuse the whole document; a partial import would register a provider
		// nobody declared.
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
	if (!installed && runtime.registry.providers().includes(provider.id)) {
		// A data file must not take the id of a provider compiled into the runtime.
		return {
			ok: false,
			status: "conflict",
			code: "HOBO_REGISTRY_ADD_CONFLICT",
			message: `hobo registry add: provider id "${provider.id}" belongs to a built-in provider.`,
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

	// What this run has to write, decided from what the stream already holds.
	//
	// Pricing catalog: absent -> store it (a first registration, or a provider
	// registered before catalogs were stored); present with a different hash ->
	// the manifest's prices changed, store the new one; same hash -> nothing.
	// Facts are append-only: the new catalog supersedes the old and the old one
	// stays in the stream.
	//
	// Registration: the ranking facts (`cost.json` prices, capability mappings)
	// ride `provider.Registered`, which is derived from the same manifest. If
	// the manifest's digest moved, re-register so those facts and the stored
	// catalog never disagree. Approval is a separate fact and is not reset.
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
	const registered = registerProviderFact(provider);
	const storedRow = registryCatalogProjection
		.query(registryCatalogProjection.fold(events))
		.find((row) => row.providerId === provider.id);
	// SAFETY: registerProviderFact builds this body with a manifestIndexDigest.
	const newDigest = (registered.data as { manifestIndexDigest: string })
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

	// One append: the registration and its pricing catalog land together or not
	// at all, so a held provider never exists without the prices it was ranked on.
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
