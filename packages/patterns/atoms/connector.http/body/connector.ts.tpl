import { bindle } from "@hobo/bindles";

export default bindle("{{name}}-connector", (b) => {
	const search = b.connector({ name: "{{name}}", kind: "http" }).allow("search");
	const api = b
		.api((ctx) => {
			if (!ctx) throw new Error("connector bindle needs Station runtime context");
			return async (request: Request): Promise<Response> => {
				const query = new URL(request.url).searchParams.get("q")?.trim();
				if (!query) {
					return Response.json({ error: "missing q" }, { status: 400 });
				}
				const connection = ctx.connector(search);
				const { token } = await connection.token({ action: "search" });
				return Response.json({ query, hasToken: token.length > 0 });
			};
		})
		.dependsOn(search);
	return { api };
});
