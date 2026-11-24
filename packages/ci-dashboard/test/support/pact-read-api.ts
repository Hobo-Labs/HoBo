import { readFileSync } from "node:fs";
import { z } from "zod";

const PACT_URL = new URL(
	"../../../ci-gh-actions/contracts/read-api.pact.json",
	import.meta.url,
);

const Interaction = z.object({
	description: z.string(),
	providerState: z.string().optional(),
	request: z.object({
		method: z.string(),
		path: z.string(),
		query: z.record(z.string(), z.array(z.string())).optional(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
	response: z.object({
		status: z.number(),
		body: z.json(),
	}),
});
export type PactInteraction = z.infer<typeof Interaction>;

export function readApiPact(): readonly PactInteraction[] {
	return z
		.object({ interactions: z.array(Interaction) })
		.parse(JSON.parse(readFileSync(PACT_URL, "utf8"))).interactions;
}

export const PACT_TOKEN = "token-a";
export const PACT_REPOSITORY = "octo/app";
export const PACT_NOW_MS = 1_794_916_800_000;

export type AskedRequest = Readonly<{
	method: string;
	url: string;
	authorization: string;
	interaction: PactInteraction | undefined;
}>;

export type PactReadApi = Readonly<{
	handle: (request: Request) => Promise<Response | undefined>;
	asked: AskedRequest[];
}>;

function matches(
	interaction: PactInteraction,
	request: Request,
	url: URL,
): boolean {
	const want = interaction.request;
	if (want.method !== request.method || want.path !== url.pathname)
		return false;
	if (
		(want.headers?.authorization ?? "") !==
		(request.headers.get("authorization") ?? "")
	)
		return false;
	const asked = url.searchParams.get("repository");
	const answered = want.query?.repository?.[0];
	return asked === null || answered === undefined || asked === answered;
}

export function pactInteractionFor(
	interactions: readonly PactInteraction[],
	request: Request,
): PactInteraction | undefined {
	const url = new URL(request.url);
	const candidates = interactions.filter((entry) =>
		matches(entry, request, url),
	);
	const asked = url.searchParams.get("repository") ?? undefined;
	return (
		candidates.find(
			(entry) => entry.request.query?.repository?.[0] === asked,
		) ?? candidates[0]
	);
}

export function pactReadApi(): PactReadApi {
	const interactions = readApiPact();
	const asked: AskedRequest[] = [];
	return {
		asked,
		handle: async (request) => {
			const url = new URL(request.url);
			if (!url.pathname.startsWith("/v1/accounts/self/")) return undefined;
			const interaction = pactInteractionFor(interactions, request);
			asked.push({
				method: request.method,
				url: `${url.pathname}${url.search}`,
				authorization: request.headers.get("authorization") ?? "",
				interaction,
			});
			if (!interaction)
				return new Response(
					'{"error":"no pact interaction","code":"unmatched"}',
					{
						status: 599,
						headers: { "content-type": "application/json" },
					},
				);
			return new Response(JSON.stringify(interaction.response.body), {
				status: interaction.response.status,
				headers: { "content-type": "application/json" },
			});
		},
	};
}
