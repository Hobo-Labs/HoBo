import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { type JunctionDefinition, junction } from "@hobo/junctions";
import { yard } from "@hobo/yards";

// The Vercel provider junction (docs/design/control-plane.md "Yard scope &
// multi-Yard (the Junction)").
//
// Domain and provider boundaries: a Yard holds only what is internal to its
// provider. The CD project's Yard runs CD itself; Vercel's projects,
// deployments and functions are internal to a Yard of their own, whose
// provider is Vercel. Nothing in either is marked external. The junction is
// how the CD Yard reaches the Vercel Yard, and the connection `hobo cd up`
// made (the integration's token in the owner's secret store) is what it
// carries: resolved from the store for one convergence, held in memory,
// never written to a file, an environment file or a result.

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
): Promise<JunctionCredentials> {
	const token = await store.port
		.access("HOBO_CD_VERCEL_TOKEN")
		.catch(() => undefined);
	if (token?.status !== "ok" || token.material === undefined)
		return {
			ok: false,
			message: `The Vercel token is not readable from ${store.id}.`,
		};
	const team = await store.port
		.access("HOBO_CD_VERCEL_TEAM_ID")
		.catch(() => undefined);
	const teamId =
		team?.status === "ok" && team.material ? team.material : undefined;
	return {
		ok: true,
		junction: vercelJunction(teamId),
		runtimeEnv: {
			VERCEL_TOKEN: token.material,
			...(teamId !== undefined ? { VERCEL_TEAM_ID: teamId } : undefined),
		},
	};
}
