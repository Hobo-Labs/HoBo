const BODY = `/** Docs search shim. Real Pagefind wasm is not shipped; /search/ is. */
export async function options() {
	return { ranking: {} };
}

export class Pagefind {
	async load() {
		return undefined;
	}

	async search(query) {
		const q = typeof query === "string" ? query.trim() : "";
		const url = "/HoBo/search/" + (q ? "?q=" + encodeURIComponent(q) : "");
		return {
			results: [
				{
					id: "hobo-docs-search",
					score: 1,
					data: async () => ({
						url,
						meta: { title: q ? "Search: " + q : "Search the docs" },
						excerpt: "HoBo docs search",
					}),
				},
			],
		};
	}
}

export default Pagefind;
`;

export function GET(): Response {
	return new Response(BODY, {
		headers: {
			"Content-Type": "text/javascript; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
