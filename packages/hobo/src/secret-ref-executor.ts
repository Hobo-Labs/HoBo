import {
	collectStream,
	type IacOutputs,
	type IacProgram,
	type IacProvider,
} from "@hobo/cloud";
import type { EventStore } from "@hobo/core";
import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { type JunctionDefinition, junction } from "@hobo/junctions";
import { yard } from "@hobo/yards";

import { planFromStream } from "./resolver-iac-provider.js";

// The executor for `secretRef` placements (`secret-store-providers.ts`).
//
// A secret store realizes a reference, never a value, so executing a
// placement on one provisions nothing. It opens the owner's store (without a
// page), confirms the store is the one the plan chose and that it answers, and
// returns the reference the workload reads at run time. Destroy leaves the
// store's entries alone: they are the owner's, not the deployment's.
//
// The store is another vendor's service, so it is internal to a Yard of its
// own (`secretStoreYard`), never to the workload's: the placement is joined by
// a provider junction, one per provider whose resources read the secret
// (`secretRefJunctions`, from the recorded plan). The junction is named in the
// outputs, so what reads the secret, and across which boundary, is on record.
//
// Every other program goes to the IaC provider this wraps.

const PREFIX = "secret-store:";

export class SecretRefExecutionError extends Error {
	readonly code:
		| "HOBO_SECRET_REF_STORE_UNAVAILABLE"
		| "HOBO_SECRET_REF_STORE_MISMATCH"
		| "HOBO_SECRET_REF_STORE_UNREADABLE"
		| "HOBO_SECRET_REF_UNPLANNED";
	constructor(code: SecretRefExecutionError["code"], message: string) {
		super(message);
		this.name = "SecretRefExecutionError";
		this.code = code;
	}
}

/** A provider id as a Yard provider: `@hobo/provider-cloudflare` is `cloudflare`. */
function yardProviderOf(providerId: string): string {
	return providerId
		.replace(/^@hobo\/provider-/u, "")
		.replace(/^secret-store:/u, "");
}

/** A DNS-safe name part. */
function namePart(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-|-$/gu, "");
}

/** The Yard a secret store's service is internal to. */
export function secretStoreYard(store: string) {
	return yard(`secret-store-${namePart(store)}`, { provider: store });
}

type PlannedNode = Readonly<{
	name: string;
	provider: string;
	deps: readonly string[];
}>;

/**
 * The provider junctions a secret placed on a store needs: for each provider
 * whose planned resources depend on it, that provider's Yard joined to the
 * store's.
 */
export function secretRefJunctions(
	deploymentId: string,
	secret: string,
	nodes: readonly PlannedNode[],
): readonly JunctionDefinition[] {
	const node = nodes.find((candidate) => candidate.name === secret);
	if (node === undefined || !node.provider.startsWith(PREFIX)) return [];
	const store = yardProviderOf(node.provider);
	const readers = [
		...new Set(
			nodes
				.filter((candidate) => candidate.deps.includes(secret))
				.map((candidate) => yardProviderOf(candidate.provider)),
		),
	].sort();
	return readers.map((provider) =>
		junction(namePart(`${deploymentId}-${secret}-${provider}`), {
			yards: [
				yard(namePart(`${deploymentId}-${provider}`), { provider }),
				secretStoreYard(store),
			],
		}),
	);
}

export function withSecretRefExecution(
	inner: IacProvider,
	options: {
		/** The owner's store, opened without a page; undefined when none opens. */
		readonly open: () => Promise<OpenedSecretStore | undefined>;
		/** Where the deployment's plan is recorded. */
		readonly store: EventStore;
	},
): IacProvider {
	const owned = (program: IacProgram) => program.provider.startsWith(PREFIX);

	const reference = async (program: IacProgram): Promise<IacOutputs> => {
		const events = await collectStream(
			options.store,
			`deployment:${program.deploymentId}`,
		);
		const nodes = planFromStream(events)?.resources ?? [];
		if (!nodes.some((node) => node.name === program.resourceId))
			throw new SecretRefExecutionError(
				"HOBO_SECRET_REF_UNPLANNED",
				`${program.resourceId} is not in deployment ${program.deploymentId}'s plan; plan before applying.`,
			);
		const junctions = secretRefJunctions(
			program.deploymentId,
			program.resourceId,
			nodes,
		);
		const wanted = yardProviderOf(program.provider);
		const opened = await options.open().catch(() => undefined);
		if (opened === undefined)
			throw new SecretRefExecutionError(
				"HOBO_SECRET_REF_STORE_UNAVAILABLE",
				`${program.resourceId} is placed on ${program.provider}, and the owner's secret store did not open; sign in to it (the committed .hobo/secret-store.json names it) and run again.`,
			);
		if (opened.id !== wanted)
			throw new SecretRefExecutionError(
				"HOBO_SECRET_REF_STORE_MISMATCH",
				`${program.resourceId} is placed on ${program.provider}, but the owner's store is ${opened.id}; plan again with the store you use, or change the locator.`,
			);
		const read = await opened.port
			.access(program.resourceId)
			.catch(() => undefined);
		if (
			read === undefined ||
			(read.status !== "ok" && read.code !== "secret-not-found")
		)
			throw new SecretRefExecutionError(
				"HOBO_SECRET_REF_STORE_UNREADABLE",
				`${opened.id} did not answer for ${program.resourceId}; check the sign-in's access to the store.`,
			);
		const ref = opened.reference(program.resourceId);
		return {
			reference: ref,
			binding: ref,
			store: opened.id,
			junctions: junctions.map((entry) => entry.name).join(","),
		};
	};

	return {
		id: `${inner.id}+secret-refs`,
		async preview(program) {
			if (!owned(program)) return inner.preview(program);
			const outputs = await reference(program);
			return { summary: `reference ${outputs.reference}`, changes: 0 };
		},
		async apply(program) {
			return owned(program) ? reference(program) : inner.apply(program);
		},
		async destroy(program) {
			if (!owned(program)) return inner.destroy(program);
		},
		async refresh(program) {
			if (!owned(program)) return inner.refresh(program);
			return { drift: false, observed: await reference(program) };
		},
	};
}
