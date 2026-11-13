/**
 * The box's own offers take their routing from committed configuration
 * (plan 0026, 3.4 and R2; ADR-0181).
 *
 * `HOBO_CI_CONFIG` / `HOBO_CI_CONFIG_JSON` (or the mesh's shared copy) still
 * carry the accounts, budgets and repository connections the daemon's journal
 * needs. What chooses where work runs does not come from them: the label an
 * offer serves (`runsOn`), its provider kind and whether it is enabled are
 * the committed provider of the same id in `.hobo/ci.json`
 * (`environments.*.policy.providers`), whose `connectionRef` is this box's
 * provider account. The offer's concurrency is `runnerRouting.box.slots`
 * (applied by the daemon), and the fleet labels the box serves are
 * `runnerRouting.labels`.
 *
 * An offer no committed provider names keeps what its configuration says and
 * is reported: unknown changes nothing (R3).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Configuration } from "@hobo/ci";
import { z } from "zod";
import { isIsolatedContainerOffer } from "../isolated-backend.js";
import {
	type CiProjectProvider,
	CiProjectProviderSchema,
} from "../project-providers.js";
import { DEFAULT_CI_PROJECT_PATH } from "../relay-routing.js";

/** Provider kinds a box worker's isolated-container offer can be. */
const BOX_PROVIDER_KINDS: ReadonlySet<string> = new Set([
	"hobo-box-worker",
	"kubernetes",
]);

export type CommittedBoxProvider = Readonly<{
	id: string;
	kind: string;
	connectionRef: string;
	runsOn: string;
	enabled: boolean;
	/** The `.hobo/ci.json` environment that commits it. */
	environment: string;
}>;

const Document = z.object({
	environments: z
		.record(
			z.string(),
			z
				.object({
					policy: z
						.object({ providers: z.array(z.json()).optional() })
						.loose()
						.optional(),
				})
				.loose(),
		)
		.optional(),
});

/**
 * Every committed box provider for `providerAccountId` in
 * `<checkoutRoot>/.hobo/ci.json`. None when the file is not there. Throws
 * when the file is not a project document or a provider is not one.
 */
export function readCommittedBoxProviders(
	checkoutRoot: string,
	providerAccountId: string,
): CommittedBoxProvider[] {
	const path = join(checkoutRoot, DEFAULT_CI_PROJECT_PATH);
	if (!existsSync(path)) return [];
	let document: z.infer<typeof Document>;
	try {
		document = Document.parse(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		throw new Error(
			`invalid ${DEFAULT_CI_PROJECT_PATH}: environments are not a project document`,
		);
	}
	const found: CommittedBoxProvider[] = [];
	for (const [environment, entry] of Object.entries(
		document.environments ?? {},
	))
		for (const raw of entry.policy?.providers ?? []) {
			const parsed = CiProjectProviderSchema.safeParse(raw);
			if (!parsed.success)
				throw new Error(
					`invalid provider in ${DEFAULT_CI_PROJECT_PATH} environment ${environment}`,
				);
			const provider: CiProjectProvider = parsed.data;
			if (
				!BOX_PROVIDER_KINDS.has(provider.kind) ||
				provider.connectionRef !== providerAccountId
			)
				continue;
			found.push({
				id: provider.id,
				kind: provider.kind,
				connectionRef: provider.connectionRef,
				runsOn: provider.runsOn,
				enabled: provider.enabled ?? true,
				environment,
			});
		}
	return found;
}

export type BoxOfferChange = Readonly<{
	accountId: string;
	offerId: string;
	field: "runsOn" | "provider" | "enabled";
	configured: string | boolean;
	committed: string | boolean;
}>;

export type BoxOfferReport = Readonly<{
	changed: readonly BoxOfferChange[];
	/** The box's offers no committed provider names; left as configured. */
	uncommitted: readonly Readonly<{ accountId: string; offerId: string }>[];
	/** Committed providers that disagree with each other for one offer id. */
	conflicting: readonly string[];
}>;

/**
 * Sets the routing fields of this box's own isolated-container offers from
 * the committed providers, in place, and says what it changed.
 */
export function applyCommittedBoxProviders(
	configuration: Configuration,
	providerAccountId: string,
	committed: readonly CommittedBoxProvider[],
): BoxOfferReport {
	const changed: BoxOfferChange[] = [];
	const uncommitted: { accountId: string; offerId: string }[] = [];
	const conflicting = new Set<string>();
	for (const account of configuration.accounts)
		for (const offer of account.offers) {
			if (
				!isIsolatedContainerOffer(offer) ||
				offer.providerAccountId !== providerAccountId
			)
				continue;
			const named = committed.filter((provider) => provider.id === offer.id);
			const [first] = named;
			const agree = named.every(
				(provider) =>
					provider.kind === first?.kind &&
					provider.runsOn === first.runsOn &&
					provider.enabled === first.enabled,
			);
			if (!first || !agree) {
				if (first) conflicting.add(offer.id);
				uncommitted.push({ accountId: account.id, offerId: offer.id });
				continue;
			}
			const set = <K extends BoxOfferChange["field"]>(
				field: K,
				configured: string | boolean,
				value: string | boolean,
				apply: () => void,
			) => {
				if (configured === value) return;
				changed.push({
					accountId: account.id,
					offerId: offer.id,
					field,
					configured,
					committed: value,
				});
				apply();
			};
			set("runsOn", offer.runsOn, first.runsOn, () => {
				offer.runsOn = first.runsOn;
			});
			set("provider", offer.provider, first.kind, () => {
				offer.provider = first.kind;
			});
			set("enabled", offer.enabled, first.enabled, () => {
				offer.enabled = first.enabled;
			});
		}
	return { changed, uncommitted, conflicting: [...conflicting].sort() };
}
