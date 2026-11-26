import { bindle } from "@hobo/bindles";
import { firecrawl as firecrawlConnector } from "@hobo/connector-firecrawl";
import { Firecrawl } from "firecrawl";

export type FirecrawlSearchHit = {
	readonly title?: string;
	readonly url?: string;
};

export type FirecrawlSearchResult = {
	readonly success?: boolean;
	readonly data?: {
		readonly web?: readonly FirecrawlSearchHit[];
	};
};

export type FirecrawlClient = {
	search(
		query: string,
		options: { limit: number },
	): Promise<FirecrawlSearchResult>;
};

export type FirecrawlClientFactory = (options: {
	apiKey: string;
}) => FirecrawlClient;

function defaultFirecrawlClient(options: { apiKey: string }): FirecrawlClient {
	const client = new Firecrawl(options);
	return {
		async search(query, searchOptions) {
			const result = await client.search(query, searchOptions);
			// SAFETY: handler only JSON-serializes the SDK search payload.
			return result as FirecrawlSearchResult;
		},
	};
}

/**
 * A tiny HTTP handler factory kept inline so the example focuses on connector
 * wiring rather than an application framework.
 *
 * The connector symbol declares which external service the Bindle needs. The
 * official Firecrawl SDK remains an ordinary application dependency. At serve
 * time the Station supplies a runtime context, resolves the connector against
 * its Connection inventory, and issues the short-lived token used by the SDK.
 *
 * Tests inject a {@link FirecrawlClientFactory} instead of mocking the module.
 */
export function createFirecrawlResearchBindle(
	createClient: FirecrawlClientFactory = defaultFirecrawlClient,
) {
	return bindle("firecrawl-research", (b) => {
		const firecrawl = b.connector(firecrawlConnector).allow("search");

		const api = b
			.api((ctx) => {
				if (!ctx) {
					throw new Error(
						"firecrawl-research requires a Station runtime context",
					);
				}

				return async (request: Request): Promise<Response> => {
					const url = new URL(request.url);
					if (url.pathname !== "/research") {
						return new Response("Not found", { status: 404 });
					}

					const query = url.searchParams.get("q")?.trim();
					if (!query) {
						return Response.json(
							{ error: "missing query parameter: q" },
							{ status: 400 },
						);
					}

					const connection = ctx.connector(firecrawl);
					const { token } = await connection.token({ action: "search" });
					const client = createClient({ apiKey: token });
					const result = await client.search(query, { limit: 5 });

					return Response.json(result);
				};
			})
			.dependsOn(firecrawl);

		return { api };
	});
}

export default createFirecrawlResearchBindle();
