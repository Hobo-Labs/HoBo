import {
	type CloudflareBindleContext,
	cloudflareBindings,
} from "../../src/cloudflare-runtime.js";

function declaration(
	kind: string,
	name: string,
	declaredAllow: string[],
	dependsOn: string[] = [],
) {
	return {
		kind,
		name,
		stableId: `${kind}:${name}`,
		declaredAllow,
		dependsOn,
		annotations:
			kind === "web" || kind === "service"
				? [
						{
							provider: "hobo",
							option: "session-replay",
							config: { enabled: false },
						},
					]
				: [],
	};
}

export const entrypoint = (context?: CloudflareBindleContext) => async () => {
	const services = cloudflareBindings(context);
	return services
		.service("catalog")
		.fetch(new Request("https://service.test/item"));
};

export const serviceEntrypoint = () => async () => new Response("catalog");

export const application = {
	name: "shop",
	resources: {
		assets: declaration("bucket", "assets", []),
		cache: declaration("kv", "cache", []),
		jobs: declaration("queue", "jobs", []),
		catalog: declaration("service", "catalog", []),
		web: declaration("web", "web", [], ["service"]),
	},
	edges: [{ from: "web", to: "catalog" }],
	requirements: {},
	entrypoint(name: string) {
		return name === "web"
			? entrypoint
			: name === "catalog"
				? serviceEntrypoint
				: undefined;
	},
};
