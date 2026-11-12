// Where `hobo ci deploy` places the relay: its Yard, and the Camp the target
// names (ADR-0179 phase 6; ADR-0157, the Yard is the binding authority).
//
// The relay's Bindle names no provider. Its Yard (`deploy/yard.ts` in the
// relay's project directory) names the provider, the project and repository,
// and a catalog of binding rows; each Camp is an environment, and lists the
// capability profiles that environment requires. Resolution here is ADR-0151
// selection, nothing more: for each required profile, the rows for it are the
// candidates (a required profile with none fails closed), and the first in the
// canonical order `@hobo/yards` already imposes is chosen. Rows never rank.
//
// From the chosen rows and the Camp, a placement takes:
// - the non-secret settings the bindings project (`properties.settings` on a
//   row, `resolverConfig.properties.settings` on the Camp);
// - the names the deploy must be given (`properties.inputs`), whose values
//   are the owner's (an identity id, a project id) and come from `--set`;
// - what a provisioning step attaches (`properties.integration` and
//   `properties.resource` on a row connected through the Vercel Marketplace).
//
// Parse, don't validate: a placement is built once from the imported Yard and
// is the only thing the deploy reads afterwards. A setting the Yard projects
// passes the same name and value screen a `--set` does.

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { TOPOLOGY_CONTRACT_VERSION, type Yard } from "@hobo/yards";

import { isJsonArray, isJsonObject, isJsonString } from "./json.js";
import {
	refusedEnvKeyReason,
	refusedEnvValueReason,
} from "./vercel-env-policy.js";

// Where a relay project keeps its Yard: outside `src/`, so the build the
// platform runs does not compile it.
export const RELAY_YARD_SOURCE_CANDIDATES = [
	"deploy/yard.js",
	"deploy/yard.mjs",
	"deploy/yard.ts",
	"deploy/yard.mts",
] as const;

// public-contract: the connectivity id a Yard row names when the Vercel Marketplace attaches it (packages/ci-vercel/deploy/yard.ts).
export const VERCEL_MARKETPLACE_CONNECTIVITY = "vercel.marketplace/v1";

export type RelayTarget = "preview" | "production";

// What a provisioning step attaches for one chosen row.
export interface MarketplaceAttachment {
	readonly profile: string;
	// The integration's slug, as `vercel integration add` takes it.
	readonly integration: string;
	// The resource's name: one per team, found by name before one is made.
	readonly resource: string;
}

// One row of the Yard's catalog, as the plan shows it.
export interface PlacedBinding {
	readonly profile: string;
	readonly productId: string;
	readonly connectivityId: string;
	// Chosen for the Camp: required by it, and first of its profile's rows.
	readonly selected: boolean;
	// The names of the settings it projects, sorted.
	readonly settings: readonly string[];
	// The names the deploy must be given for it, sorted.
	readonly inputs: readonly string[];
	// "marketplace:<integration>" for a row the Marketplace attaches, else "".
	readonly provisioning: string;
}

// What `resolveRelayPlacement` parsed out of a Yard; built nowhere else.
export interface RelayPlacement {
	readonly yard: string;
	// The Camp's canonical id, `<yard>/<camp>`.
	readonly camp: string;
	readonly providerId: string;
	readonly regions: readonly string[];
	// The Yard's placement properties, when it declares them.
	readonly project?: string;
	readonly repository?: string;
	readonly rootDirectory?: string;
	// Settings the chosen bindings and the Camp project, by name.
	readonly settings: ReadonlyMap<string, string>;
	// Names the deploy must be given, sorted.
	readonly inputs: readonly string[];
	readonly bindings: readonly PlacedBinding[];
	readonly attachments: readonly MarketplaceAttachment[];
}

export class RelayPlacementRefusal extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "RelayPlacementRefusal";
		this.code = code;
	}
}

function refuse(code: string, message: string): never {
	throw new RelayPlacementRefusal(code, message);
}

// A Yard as `yard()` makes it, recognized by its contract, not by its name.
function isYard<T>(value: T): value is T & Yard {
	return (
		isJsonObject(value) &&
		value.kind === "yard" &&
		value.contract === TOPOLOGY_CONTRACT_VERSION &&
		isJsonString(value.name) &&
		isJsonString(value.providerId) &&
		isJsonArray(value.bindings) &&
		isJsonArray(value.camps)
	);
}

// The Yard the project at `projectDir` declares, or undefined when it has no
// Yard source. A source that does not import, or exports no Yard, is refused:
// a deploy that silently fell back to another placement would be worse.
export async function loadRelayYard(
	projectDir: string,
): Promise<Yard | undefined> {
	for (const candidate of RELAY_YARD_SOURCE_CANDIDATES) {
		const absolute = path.join(projectDir, candidate);
		if (!existsSync(absolute)) continue;
		let module: object;
		try {
			module = await import(pathToFileURL(absolute).href);
		} catch {
			return refuse(
				"HOBO_CI_DEPLOY_YARD_UNREADABLE",
				`${candidate} could not be imported. Run hobo ci deploy under a TypeScript-aware loader (node --import tsx) or build it first.`,
			);
		}
		const exported = Object.entries(module).find(
			([name]) => name === "default",
		)?.[1];
		if (!isYard(exported))
			return refuse(
				"HOBO_CI_DEPLOY_YARD_UNREADABLE",
				`${candidate} does not export a Yard as its default export (export default yard(...)).`,
			);
		return exported;
	}
	return undefined;
}

// The property bag of a binding row or of a Camp's resolver config.
type PropertyBag =
	| Yard["bindings"][number]["properties"]
	| Yard["camps"][number]["resolverConfig"]["properties"];

// `properties.settings` of a row or a Camp: names to string values.
function settingsOf(
	where: string,
	properties: PropertyBag,
): ReadonlyMap<string, string> {
	const raw = properties.settings;
	if (raw === undefined) return new Map();
	if (!isJsonObject(raw))
		return refuse(
			"HOBO_CI_DEPLOY_BINDING_MALFORMED",
			`${where}: properties.settings must map setting names to string values.`,
		);
	const settings = new Map<string, string>();
	for (const [name, value] of Object.entries(raw)) {
		if (!isJsonString(value))
			return refuse(
				"HOBO_CI_DEPLOY_BINDING_MALFORMED",
				`${where}: the setting ${name} must have a string value.`,
			);
		const byName = refusedEnvKeyReason(name);
		if (byName !== undefined)
			return refuse(
				"HOBO_CI_DEPLOY_SETTING_REFUSED",
				`${where} projects the setting ${name}, whose name ${byName}. A binding projects configuration, never a credential.`,
			);
		const byValue = refusedEnvValueReason(value);
		if (byValue !== undefined)
			return refuse(
				"HOBO_CI_DEPLOY_SETTING_REFUSED",
				`${where} projects a value for ${name} that ${byValue}.`,
			);
		settings.set(name, value);
	}
	return settings;
}

// `properties.inputs` of a row: names of settings the deploy is given.
function inputsOf(where: string, properties: PropertyBag): readonly string[] {
	const raw = properties.inputs;
	if (raw === undefined) return [];
	const malformed = () =>
		refuse(
			"HOBO_CI_DEPLOY_BINDING_MALFORMED",
			`${where}: properties.inputs must list setting names.`,
		);
	if (!isJsonArray(raw)) return malformed();
	const names: string[] = [];
	for (const entry of raw) {
		if (!isJsonString(entry)) return malformed();
		names.push(entry);
	}
	for (const name of names) {
		const byName = refusedEnvKeyReason(name);
		if (byName !== undefined)
			return refuse(
				"HOBO_CI_DEPLOY_SETTING_REFUSED",
				`${where} asks for the input ${name}, whose name ${byName}. An input is configuration, never a credential.`,
			);
	}
	return [...new Set(names)].sort();
}

function attachmentOf(
	row: Yard["bindings"][number],
): MarketplaceAttachment | undefined {
	if (row.connectivityId !== VERCEL_MARKETPLACE_CONNECTIVITY) return undefined;
	const { integration, resource } = row.properties;
	if (
		!isJsonString(integration) ||
		!/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/u.test(integration) ||
		!isJsonString(resource) ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(resource)
	)
		return refuse(
			"HOBO_CI_DEPLOY_BINDING_MALFORMED",
			`The ${row.profile} row attached through the Vercel Marketplace must name its integration slug and its resource.`,
		);
	return { profile: row.profile, integration, resource };
}

function placementProperty(yard: Yard, key: string): string | undefined {
	const value = yard.properties[key];
	return isJsonString(value) && value !== "" ? value : undefined;
}

// The relay's placement for `target`: the Yard's Camp whose envType is the
// target, and the rows chosen for the profiles it requires.
export function resolveRelayPlacement(
	yard: Yard,
	target: RelayTarget,
): RelayPlacement {
	const camps = yard.camps.filter((entry) => entry.envType === target);
	if (camps.length === 0)
		return refuse(
			"HOBO_CI_DEPLOY_NO_CAMP",
			`Yard ${yard.name} has no Camp for ${target}. Add camp("${target}", { envType: "${target}", require: [...] }) to it.`,
		);
	if (camps.length > 1)
		return refuse(
			"HOBO_CI_DEPLOY_NO_CAMP",
			`Yard ${yard.name} has ${camps.length} Camps for ${target} (${camps.map((entry) => entry.id).join(", ")}); a target must name one.`,
		);
	const [camp] = camps;
	if (camp === undefined)
		return refuse("HOBO_CI_DEPLOY_NO_CAMP", `No Camp for ${target}.`);

	// ADR-0151: the required profiles are the hard gate; the canonical row
	// order (`parseYardBindings`) is the lexicographic one.
	const chosen = new Set<Yard["bindings"][number]>();
	for (const profile of camp.require) {
		const first = yard.bindings.find((row) => row.profile === profile);
		if (first === undefined)
			return refuse(
				"HOBO_CI_DEPLOY_BINDING_UNAVAILABLE",
				`Camp ${camp.id} requires ${profile}, and Yard ${yard.name} has no row for it.`,
			);
		chosen.add(first);
	}

	const settings = new Map<string, string>();
	const inputs = new Set<string>();
	const attachments: MarketplaceAttachment[] = [];
	const projectSettings = (
		where: string,
		from: ReadonlyMap<string, string>,
	) => {
		for (const [name, value] of from) {
			const earlier = settings.get(name);
			if (earlier !== undefined && earlier !== value)
				refuse(
					"HOBO_CI_DEPLOY_BINDING_CONFLICT",
					`${where} sets ${name}, which another chosen binding of Camp ${camp.id} sets differently. Rows are a set: two that disagree are an authoring defect.`,
				);
			settings.set(name, value);
		}
	};
	const bindings = yard.bindings.map((row): PlacedBinding => {
		const where = `The ${row.profile} row (${row.productId ?? row.connectivityId ?? "-"}) of Yard ${yard.name}`;
		const rowSettings = settingsOf(where, row.properties);
		const rowInputs = inputsOf(where, row.properties);
		const attachment = attachmentOf(row);
		const selected = chosen.has(row);
		if (selected) {
			projectSettings(where, rowSettings);
			for (const name of rowInputs) inputs.add(name);
			if (attachment !== undefined) attachments.push(attachment);
		}
		return {
			profile: row.profile,
			productId: row.productId ?? "",
			connectivityId: row.connectivityId ?? "",
			selected,
			settings: [...rowSettings.keys()].sort(),
			inputs: rowInputs,
			provisioning:
				attachment !== undefined ? `marketplace:${attachment.integration}` : "",
		};
	});
	projectSettings(
		`Camp ${camp.id}`,
		settingsOf(`Camp ${camp.id}`, camp.resolverConfig.properties),
	);
	for (const name of inputs)
		if (settings.has(name))
			refuse(
				"HOBO_CI_DEPLOY_BINDING_CONFLICT",
				`Camp ${camp.id} both sets ${name} and asks the deploy for it.`,
			);

	const project = placementProperty(yard, "project");
	const repository = placementProperty(yard, "repository");
	const rootDirectory = placementProperty(yard, "rootDirectory");
	return Object.freeze({
		yard: yard.name,
		camp: camp.id,
		providerId: yard.providerId,
		regions: yard.regions,
		...(project !== undefined ? { project } : undefined),
		...(repository !== undefined ? { repository } : undefined),
		...(rootDirectory !== undefined ? { rootDirectory } : undefined),
		settings,
		inputs: [...inputs].sort(),
		bindings,
		attachments,
	});
}
