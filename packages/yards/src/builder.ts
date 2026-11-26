import {
	type Camp,
	camp,
	type ProviderSelection,
	standardCamps,
} from "@hobo/camps";
import {
	CAPABILITY_SLOTS,
	type CampTier,
	type CapabilitySlot,
	ENV_TYPES,
	type EnvType,
	isCampTier,
	isEnvType,
	type SlotBinding,
} from "@hobo/core";
import {
	type DefineYardConfig,
	defineStation,
	defineYard,
	type StationManifest,
} from "./define.js";
import { isJsonString, type JsonValue, type StringBag } from "./json.js";
import type { Yard } from "./yard.js";

export type BuilderErrorCode =
	| "CAMP_TIER_UNKNOWN"
	| "ENV_TYPE_UNKNOWN"
	| "PROVIDER_REF_UNRESOLVED"
	| "SLOT_CALL_EMPTY";

export class BuilderError extends Error {
	readonly code: BuilderErrorCode;
	readonly remediation: string;

	constructor(code: BuilderErrorCode, message: string, remediation: string) {
		super(message);
		this.name = "BuilderError";
		this.code = code;
		this.remediation = remediation;
	}
}

export interface ProviderNamespaceRef {
	readonly PROVIDER_ID: string;
}

export type ProviderRef =
	| string
	| { readonly id: string }
	| ProviderNamespaceRef;

export function providerIdOf(provider: ProviderRef): string {
	if (isJsonString(provider) && provider.length > 0) return provider;
	if (provider !== null && provider !== undefined) {
		const namespaceId = (provider as Partial<ProviderNamespaceRef>).PROVIDER_ID;
		if (isJsonString(namespaceId) && namespaceId.length > 0) {
			return namespaceId;
		}
		const objectId = (provider as Partial<{ id: string }>).id;
		if (isJsonString(objectId) && objectId.length > 0) return objectId;
	}
	throw new BuilderError(
		"PROVIDER_REF_UNRESOLVED",
		`cannot resolve a provider id from ${JSON.stringify(provider)} — a provider is stated, never inferred`,
		'Pass the provider as the first argument to yard(): yard(azure, "prod-eu", …). A namespace object is preferred; a provider id string or { id } is accepted for providers with no namespace package.',
	);
}

export type YardSlotMethods = {
	readonly [K in CapabilitySlot]: (...bindings: SlotBinding[]) => YardBuilder;
};

export interface YardBuilder extends YardSlotMethods {
	region(...regions: string[]): YardBuilder;
	residency(...residency: string[]): YardBuilder;
	componentHost(...hosts: string[]): YardBuilder;
	label(key: string, value: string): YardBuilder;
	slot(slot: CapabilitySlot, ...bindings: SlotBinding[]): YardBuilder;
	camp(name: string, build?: (builder: CampBuilder) => void): YardBuilder;
	camp(existing: Camp): YardBuilder;
	standardCamps(envType: EnvType, tiers?: readonly CampTier[]): YardBuilder;
	readonly providerId: string;
}

export interface CampBuilder {
	logicalId(id: string): CampBuilder;
	envType(envType: EnvType): CampBuilder;
	production(): CampBuilder;
	staging(): CampBuilder;
	preview(): CampBuilder;
	development(): CampBuilder;
	tier(tier: CampTier): CampBuilder;
	require(...requirements: string[]): CampBuilder;
	prefer(...preferences: string[]): CampBuilder;
	label(key: string, value: string): CampBuilder;
	runtime(...requirements: string[]): CampBuilder;
	pin(slot: CapabilitySlot, resolverId: string): CampBuilder;
	provider(selection: JsonValue): CampBuilder;
	bindle(owned: JsonValue): CampBuilder;
}

export interface StationBuilder {
	tenant(tenant: string): StationBuilder;
	residency(residency: string): StationBuilder;
	trustDomain(trustDomain: string): StationBuilder;
	airgap(airgap?: boolean): StationBuilder;
	yard(
		provider: ProviderRef,
		name: string,
		build: (builder: YardBuilder) => void,
	): StationBuilder;
	yard(existing: Yard): StationBuilder;
}

export function buildCamp(
	name: string,
	build?: (builder: CampBuilder) => void,
): Camp {
	const draft = new CampDraft();
	build?.(draft);
	return draft.compile(name);
}

export function buildYard(
	provider: ProviderRef,
	name: string,
	build: (builder: YardBuilder) => void,
): Yard {
	const draft = new YardDraft(providerIdOf(provider));
	build(draft);
	return draft.compile(name);
}

export function buildStation(
	name: string,
	build: (builder: StationBuilder) => void,
): StationManifest {
	const draft = new StationDraft();
	build(draft);
	return draft.compile(name);
}

class CampDraft implements CampBuilder {
	#logicalId: string | undefined;
	#envType: string | undefined;
	#tier: CampTier | undefined;
	readonly #require: string[] = [];
	readonly #prefer: string[] = [];
	readonly #labels = new Map<string, string>();
	readonly #runtime: string[] = [];
	readonly #pins = new Map<string, string>();
	#provider: unknown;
	#bindle: unknown;
	#providerAuthored = false;
	#bindleAuthored = false;

	logicalId(id: string): CampBuilder {
		this.#logicalId = id;
		return this;
	}

	envType(envType: EnvType): CampBuilder {
		if (!isEnvType(envType)) {
			throw new BuilderError(
				"ENV_TYPE_UNKNOWN",
				`camp envType ${JSON.stringify(envType)} is not a declared environment type`,
				`Use one of: ${ENV_TYPES.join(", ")} — or the named methods production() / staging() / preview() / development().`,
			);
		}
		this.#envType = envType;
		return this;
	}

	production(): CampBuilder {
		return this.envType("production");
	}

	staging(): CampBuilder {
		return this.envType("staging");
	}

	preview(): CampBuilder {
		return this.envType("ephemeral");
	}

	development(): CampBuilder {
		return this.envType("development");
	}

	tier(tier: CampTier): CampBuilder {
		if (!isCampTier(tier)) {
			throw new BuilderError(
				"CAMP_TIER_UNKNOWN",
				`camp tier ${JSON.stringify(tier)} is not a named tier`,
				"Use a value from CAMP_TIERS (edge, app, data, untrusted, ops), or omit tier for a Camp that segments on some other axis.",
			);
		}
		this.#tier = tier;
		return this;
	}

	require(...requirements: string[]): CampBuilder {
		this.#require.push(...requirements);
		return this;
	}

	prefer(...preferences: string[]): CampBuilder {
		this.#prefer.push(...preferences);
		return this;
	}

	label(key: string, value: string): CampBuilder {
		this.#labels.set(key, value);
		return this;
	}

	runtime(...requirements: string[]): CampBuilder {
		this.#runtime.push(...requirements);
		return this;
	}

	pin(slot: string, resolverId: string): CampBuilder {
		this.#pins.set(slot, resolverId);
		return this;
	}

	provider(selection: JsonValue): CampBuilder {
		this.#provider = selection;
		this.#providerAuthored = true;
		return this;
	}

	bindle(owned: JsonValue): CampBuilder {
		this.#bindle = owned;
		this.#bindleAuthored = true;
		return this;
	}

	compile(name: string): Camp {
		const pins = [...this.#pins.entries()]
			.sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
			.map(([slot, resolverId]) => ({ slot, resolverId }));
		const authoredProvider = this.#providerAuthored
			? { defaultProvider: this.#provider as ProviderSelection }
			: undefined;
		return camp(name, {
			...(this.#logicalId !== undefined
				? { logicalId: this.#logicalId }
				: undefined),
			...(this.#envType !== undefined ? { envType: this.#envType } : undefined),
			...(this.#tier !== undefined ? { tier: this.#tier } : undefined),
			require: [...this.#require],
			prefer: [...this.#prefer],
			labels: sortedRecord(this.#labels),
			runtimeRequirements: [...this.#runtime],
			...(pins.length > 0 ? { resolverConfig: { pins } } : undefined),
			...authoredProvider,
			...(this.#bindleAuthored ? { bindle: this.#bindle } : undefined),
		});
	}
}

class YardDraft implements YardBuilder {
	readonly #provider: string;
	readonly #regions: string[] = [];
	readonly #residency: string[] = [];
	readonly #componentHosts: string[] = [];
	readonly #labels = new Map<string, string>();
	readonly #slots = new Map<CapabilitySlot, SlotBinding[]>();
	readonly #camps: Camp[] = [];

	constructor(providerId: string) {
		this.#provider = providerId;
	}

	get providerId(): string {
		return this.#provider;
	}

	region(...regions: string[]): this {
		this.#regions.push(...regions);
		return this;
	}

	residency(...residency: string[]): this {
		this.#residency.push(...residency);
		return this;
	}

	componentHost(...hosts: string[]): this {
		this.#componentHosts.push(...hosts);
		return this;
	}

	label(key: string, value: string): this {
		this.#labels.set(key, value);
		return this;
	}

	slot(slot: CapabilitySlot, ...bindings: SlotBinding[]): this {
		if (bindings.length === 0) {
			throw new BuilderError(
				"SLOT_CALL_EMPTY",
				`slot ${slot} was declared with no offerings — a slot that names nothing constrains nothing`,
				`Pass at least one offering (y.${slot}(azure.…())) or omit the call.`,
			);
		}
		const existing = this.#slots.get(slot);
		if (existing === undefined) {
			this.#slots.set(slot, [...bindings]);
		} else {
			existing.push(...bindings);
		}
		return this;
	}

	web(...bindings: SlotBinding[]): this {
		return this.slot("web", ...bindings);
	}

	api(...bindings: SlotBinding[]): this {
		return this.slot("api", ...bindings);
	}

	service(...bindings: SlotBinding[]): this {
		return this.slot("service", ...bindings);
	}

	data(...bindings: SlotBinding[]): this {
		return this.slot("data", ...bindings);
	}

	kv(...bindings: SlotBinding[]): this {
		return this.slot("kv", ...bindings);
	}

	bucket(...bindings: SlotBinding[]): this {
		return this.slot("bucket", ...bindings);
	}

	queue(...bindings: SlotBinding[]): this {
		return this.slot("queue", ...bindings);
	}

	topic(...bindings: SlotBinding[]): this {
		return this.slot("topic", ...bindings);
	}

	secretRef(...bindings: SlotBinding[]): this {
		return this.slot("secretRef", ...bindings);
	}

	webhook(...bindings: SlotBinding[]): this {
		return this.slot("webhook", ...bindings);
	}

	schedule(...bindings: SlotBinding[]): this {
		return this.slot("schedule", ...bindings);
	}

	standardCamps(envType: EnvType, tiers?: readonly CampTier[]): this {
		for (const built of standardCamps(
			envType,
			tiers === undefined ? {} : { tiers },
		)) {
			this.#camps.push(built);
		}
		return this;
	}

	camp(
		nameOrCamp: string | Camp,
		build?: (builder: CampBuilder) => void,
	): this {
		this.#camps.push(
			isJsonString(nameOrCamp) ? buildCamp(nameOrCamp, build) : nameOrCamp,
		);
		return this;
	}

	compile(name: string): Yard {
		const slots: Record<string, readonly SlotBinding[]> = {};
		for (const slot of CAPABILITY_SLOTS) {
			const bindings = this.#slots.get(slot);
			if (bindings !== undefined) slots[slot] = bindings;
		}
		return defineYard(name, {
			...slots,
			provider: this.#provider,
			regions: [...this.#regions],
			residency: [...this.#residency],
			componentHosts: [...this.#componentHosts],
			labels: sortedRecord(this.#labels),
			camps: [...this.#camps].sort(compareCampIds),
		} as DefineYardConfig);
	}
}

class StationDraft implements StationBuilder {
	#tenant: string | undefined;
	#residency: string | undefined;
	#trustDomain: string | undefined;
	#airgap = false;
	readonly #yards: Yard[] = [];

	tenant(tenant: string): StationBuilder {
		this.#tenant = tenant;
		return this;
	}

	residency(residency: string): StationBuilder {
		this.#residency = residency;
		return this;
	}

	trustDomain(trustDomain: string): StationBuilder {
		this.#trustDomain = trustDomain;
		return this;
	}

	airgap(airgap = true): StationBuilder {
		this.#airgap = airgap;
		return this;
	}

	yard(
		providerOrYard: ProviderRef | Yard,
		name?: string,
		build?: (builder: YardBuilder) => void,
	): StationBuilder {
		if (name === undefined) {
			this.#yards.push(providerOrYard as Yard);
			return this;
		}
		this.#yards.push(
			buildYard(
				providerOrYard as ProviderRef,
				name,
				build ?? (() => undefined),
			),
		);
		return this;
	}

	compile(name: string): StationManifest {
		return defineStation(name, {
			isolation: {
				...(this.#tenant !== undefined ? { tenant: this.#tenant } : undefined),
				...(this.#residency !== undefined
					? { residency: this.#residency }
					: undefined),
				...(this.#trustDomain !== undefined
					? { trustDomain: this.#trustDomain }
					: undefined),
				airgap: this.#airgap,
			},
			yards: this.#yards,
		});
	}
}

function sortedRecord(
	entries: ReadonlyMap<string, string>,
): Readonly<StringBag> {
	const out: Record<string, string> = {};
	for (const [key, value] of [...entries.entries()].sort(([a], [b]) =>
		a === b ? 0 : a < b ? -1 : 1,
	)) {
		out[key] = value;
	}
	return out;
}

function compareCampIds(a: Camp, b: Camp): number {
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}
