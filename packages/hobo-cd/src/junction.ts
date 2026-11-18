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
			/** For this run only: the deploy provider's token and team. */
			readonly runtimeEnv: Readonly<Record<string, string>>;
	  }
	| { readonly ok: false; readonly message: string };

/** Resolve the Vercel junction's credential from the owner's store. */
export async function resolveVercelJunction(
	store: OpenedSecretStore,
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
	return {
		ok: true,
		junction: vercelJunction(teamId),
		runtimeEnv: {
			VERCEL_TOKEN: token,
			...(teamId !== undefined ? { VERCEL_TEAM_ID: teamId } : undefined),
		},
	};
}
