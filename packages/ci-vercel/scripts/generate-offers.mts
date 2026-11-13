/**
 * Lower the relay's offer manifests (`offers/*.provider.yaml`, ADR-0179
 * phase 5) into `@hobo/pricing` catalogs with `@hobo/provider-manifest`, and
 * derive from those catalogs the relay's default cache offers and its
 * lifecycle-driver offers. Writes `src/_generated-assets/relay-offers.ts`;
 * `--check` fails when the file on disk is not what the manifests produce.
 *
 * What a catalog cannot say is recorded here, in the binding table, with
 * its reason: which offer a cache backend's default comes from, that a free
 * plan is blocked (not billed) when its allowance runs out, and when a
 * lifecycle driver becomes available.
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { toJson } from "@bufbuild/protobuf";
import { PricingCatalogSchema, parseDecimal } from "@hobo/pricing";
import {
	type BillingLowering,
	type ParsedProviderManifest,
	parseProviderManifest,
	toPricingCatalog,
} from "@hobo/provider-manifest";

type Unit =
	| "commands"
	| "rows-read"
	| "rows-written"
	| "simple-operations"
	| "advanced-operations";
const UNITS: readonly Unit[] = [
	"commands",
	"rows-read",
	"rows-written",
	"simple-operations",
	"advanced-operations",
];
function isUnit(value: string): value is Unit {
	return UNITS.some((unit) => unit === value);
}

/** Each cache backend's default offer: the manifest product and plan it comes from. */
const CACHE_BINDINGS = [
	// Upstash's free plan is blocked when its 500,000 commands are spent.
	{
		backend: "upstash",
		manifest: "upstash-redis",
		product: "redis-free",
		plan: "free",
		tier: "free",
		beyond: "hard-stop",
	},
	// `VALKEY_URL` is Aiven's free plan or a self-hosted Valkey: neither caps commands.
	{
		backend: "valkey",
		manifest: "aiven-valkey",
		product: "valkey-free",
		plan: "free",
		tier: "free",
		beyond: "hard-stop",
	},
	// Turso's free plan is blocked when its rows are spent.
	{
		backend: "turso",
		manifest: "turso",
		product: "libsql-free",
		plan: "free",
		tier: "free",
		beyond: "hard-stop",
	},
	// Blob is pay-as-you-go: admitted only under a cap the owner declares.
	{
		backend: "blob",
		manifest: "vercel-blob",
		product: "blob-private",
		plan: "pay-as-you-go",
		tier: "payg",
		beyond: "metered",
	},
] as const;

/** The lease lifecycle drivers, and when each may be chosen. */
const LIFECYCLE_BINDINGS = [
	{
		driver: "queues",
		manifest: "vercel-queues",
		product: "queues",
		plan: "pay-as-you-go",
		built: true,
		availableFrom: "2026-11-11",
	},
	// Needs `workflow` >= 5.4.0, pinnable under the two-week rule from this
	// date, and the driver itself (phase 4d), which is not built.
	{
		driver: "workflows",
		manifest: "vercel-workflows",
		product: "workflows-managed",
		plan: "pro",
		built: false,
		availableFrom: "2026-11-18",
	},
] as const;

const offersDirectory = new URL("../offers/", import.meta.url);
const files = (await readdir(offersDirectory))
	.filter((name) => name.endsWith(".provider.yaml"))
	.sort();
const lowered = new Map<
	string,
	{ manifest: ParsedProviderManifest; billing: BillingLowering }
>();
for (const file of files) {
	const parsed = parseProviderManifest(
		await readFile(new URL(file, offersDirectory), "utf8"),
	);
	if (!parsed.ok)
		throw new Error(
			`${file}: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
		);
	const billing = toPricingCatalog(parsed.manifest);
	if (!billing) throw new Error(`${file}: no billing section`);
	lowered.set(file.replace(/\.provider\.yaml$/u, ""), {
		manifest: parsed.manifest,
		billing,
	});
}

function source(name: string) {
	const entry = lowered.get(name);
	if (!entry) throw new Error(`no offer manifest ${name}`);
	return entry;
}

/** Micro-dollars per unit from an exact decimal per-unit price. */
function micros(decimal: string): number {
	const value = parseDecimal(decimal);
	if (value === undefined) throw new Error(`invalid price ${decimal}`);
	const result = Number(decimal) * 1_000_000;
	if (!Number.isFinite(result) || result < 0)
		throw new Error(`invalid price ${decimal}`);
	return Math.round(result * 1_000_000) / 1_000_000;
}

/** Selection by capability: an offer must declare the profile the relay requires. */
function requireProfile(name: string, product: string, profile: string) {
	const { manifest } = source(name);
	const mapping = manifest.capabilities?.mappings.find((entry) =>
		entry.products.includes(product),
	);
	if (!mapping?.profiles.includes(profile))
		throw new Error(`${name}: ${product} does not declare ${profile}`);
}
for (const binding of CACHE_BINDINGS)
	requireProfile(binding.manifest, binding.product, "kv.ephemeral-state/v1");
for (const binding of LIFECYCLE_BINDINGS)
	requireProfile(
		binding.manifest,
		binding.product,
		"lifecycle.lease-driver/v1",
	);

function rated(name: string, product: string, plan: string) {
	const { manifest, billing } = source(name);
	const plans = billing.rated.filter(
		(entry) => entry.productId === product && entry.planId === plan,
	);
	const card = billing.catalog.rateCards.find(
		(entry) => entry.id === plans[0]?.rateCardId,
	);
	const evidence = {
		source:
			`${manifest.billing?.source?.url ?? ""} (offers/${name}.provider.yaml${manifest.billing?.source?.note ? `; ${manifest.billing.source.note}` : ""})`.slice(
				0,
				300,
			),
		observedAt: manifest.billing?.source?.checkedAt ?? "",
	};
	return { manifest, billing, card, evidence };
}

const cacheOffers = CACHE_BINDINGS.map((binding) => {
	const { billing, card, evidence } = rated(
		binding.manifest,
		binding.product,
		binding.plan,
	);
	if (!card)
		throw new Error(
			`${binding.manifest}: ${binding.product}/${binding.plan} is not rated`,
		);
	const included = new Map(
		billing.included
			.filter(
				(entry) =>
					entry.productId === binding.product && entry.planId === binding.plan,
			)
			.map((entry) => [entry.billable, Number(entry.quantity)]),
	);
	const allowances = card.charges.flatMap((charge) => {
		if (charge.variant.case !== "usage") return [];
		const usage = charge.variant.value;
		const unit = usage.dimension;
		if (!isUnit(unit))
			throw new Error(`${binding.manifest}: unknown unit ${usage.dimension}`);
		if (usage.price.case !== "perUnit")
			throw new Error(
				`${binding.manifest}: ${usage.dimension} is not per unit`,
			);
		const price = micros(usage.price.value.decimal);
		if (binding.beyond === "metered")
			return [
				{
					unit,
					included: included.get(unit) ?? 0,
					beyond: "metered" as const,
					meteredMicrosPerUnit: price,
				},
			];
		// A free plan: its allowance, then blocked; no allowance means no cap.
		if (price !== 0)
			throw new Error(`${binding.manifest}: a free plan with a price`);
		const quantity = included.get(unit);
		return quantity === undefined
			? []
			: [{ unit, included: quantity, beyond: "hard-stop" as const }];
	});
	return {
		backend: binding.backend,
		tier: binding.tier,
		plan: binding.plan,
		rateCardId: card.id,
		catalogHash: billing.catalog.catalogHash,
		allowances,
		evidence,
	};
});

const lifecycleOffers = LIFECYCLE_BINDINGS.map((binding) => {
	const { billing, card, evidence } = rated(
		binding.manifest,
		binding.product,
		binding.plan,
	);
	const unrated = billing.unrated.find(
		(entry) =>
			entry.productId === binding.product && entry.planId === binding.plan,
	);
	const usage = card?.charges.find((charge) => charge.variant.case === "usage");
	const price =
		usage?.variant.case === "usage" &&
		usage.variant.value.price.case === "perUnit"
			? micros(usage.variant.value.price.value.decimal)
			: undefined;
	return {
		driver: binding.driver,
		built: binding.built,
		availableFrom: binding.availableFrom,
		rateCardId: card?.id ?? "",
		catalogHash: billing.catalog.catalogHash,
		// Unrated (an unverified price) is never read as free.
		microsPerUnit: price ?? null,
		unit: usage?.variant.case === "usage" ? usage.variant.value.dimension : "",
		unrated: unrated ? unrated.reason : "",
		evidence,
	};
});

const catalogs = [...lowered.entries()].map(
	([name, { manifest, billing }]) => ({
		manifest: `offers/${name}.provider.yaml`,
		providerId: manifest.provider?.id ?? "",
		profiles: [
			...new Set(
				manifest.capabilities?.mappings.flatMap(
					(mapping) => mapping.profiles,
				) ?? [],
			),
		].sort(),
		catalogHash: billing.catalog.catalogHash,
		catalog: toJson(PricingCatalogSchema, billing.catalog),
	}),
);

const source_ = `// Generated by scripts/generate-offers.mts from offers/*.provider.yaml. Do not edit.
/** The relay's offers lowered into @hobo/pricing catalogs, one per manifest. */
export const RELAY_OFFER_CATALOGS = ${JSON.stringify(catalogs)} as const;
/** Each cache backend's default offer, derived from its catalog's rate card. */
export const RELAY_CACHE_OFFER_DEFAULTS = ${JSON.stringify(cacheOffers)} as const;
/** The lease lifecycle drivers' offers; a driver is chosen only once built and available. */
export const RELAY_LIFECYCLE_OFFERS = ${JSON.stringify(lifecycleOffers)} as const;
`;
const destination = new URL(
	"../src/_generated-assets/relay-offers.ts",
	import.meta.url,
);
const generated = execFileSync(
	process.execPath,
	[
		createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome"),
		"format",
		`--stdin-file-path=${fileURLToPath(destination)}`,
	],
	{
		cwd: new URL("../../../", import.meta.url),
		input: source_,
		encoding: "utf8",
	},
);
if (process.argv.includes("--check")) {
	if ((await readFile(destination, "utf8").catch(() => "")) !== generated)
		throw new Error("relay offers are stale; run scripts/generate-offers.mts");
} else {
	await writeFile(destination, generated);
}
