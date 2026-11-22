import type { TrustedVault } from "@hobo/core";
import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { type JunctionDefinition, junction } from "@hobo/junctions";
import { yard } from "@hobo/yards";
import { readVercelConnection, type StoredVercelConnection } from "./vercel.js";

/** The CD project's own Yard: where HoBo.CD runs (the local Station by default). */
export const cdYard = yard("hobo-cd", {
	provider: "local",
	labels: { project: "hobo-cd" },
});

/** The Yard Vercel's resources are internal to. */
export function vercelYard(teamId?: string) {
	return yard("hobo-cd-vercel", {
		provider: "vercel",
		labels: { project: "hobo-cd" },
		...(teamId !== undefined ? { properties: { teamId } } : undefined),
	});
}

/** The CD Yard joined to the Vercel Yard. */
export function vercelJunction(teamId?: string): JunctionDefinition {
	return junction("hobo-cd-vercel", { yards: [cdYard, vercelYard(teamId)] });
}

export type JunctionCredentials =
	| {
			readonly ok: true;
			readonly junction: JunctionDefinition;
			/** The team the deploy targets, when the Integration names one. */
			readonly teamId: string | undefined;
	  }
	| { readonly ok: false; readonly message: string };

/**
 * Resolve the Vercel junction's credential from the owner's store into the
 * run's trusted vault (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`): memory only, for the
 * deploy this run makes.
 */
export async function resolveVercelJunction(
	store: OpenedSecretStore,
	vault: TrustedVault,
	matches?: (connection: StoredVercelConnection) => boolean,
): Promise<JunctionCredentials> {
	let connection: Awaited<ReturnType<typeof readVercelConnection>>;
	try {
		connection = await readVercelConnection(store);
	} catch {
		return {
			ok: false,
			message: `The Vercel connection is incomplete or unreadable in ${store.id}.`,
		};
	}
	if (!connection)
		return {
			ok: false,
			message: `The Vercel connection is not present in ${store.id}.`,
		};
	if (matches && !matches(connection))
		return {
			ok: false,
			message: `The Vercel connection changed while reading ${store.id}.`,
		};
	const { token, teamId } = connection;
	vault.put("VERCEL_TOKEN", token);
	if (teamId !== undefined) vault.put("VERCEL_TEAM_ID", teamId);
	else vault.drop("VERCEL_TEAM_ID");
	return { ok: true, junction: vercelJunction(teamId), teamId };
}
