import { bindle } from "@hobo/bindles";

export const runtime = {
	schemaVersion: "hobo.try-runtime/v1",
	resources: {},
	routes: [
		{ method: "GET", path: "/health", action: "health" },
		{ method: "POST", path: "/api/greet", action: "greet" },
	],
} as const;

export default bindle((b) => ({
	web: b.web(),
}));
