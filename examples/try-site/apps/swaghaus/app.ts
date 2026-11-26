import { bindle } from "@hobo/bindles";
import { convexApp } from "@hobo/convex";

/**
 * Real JamesCowling/swaghaus Bindle.
 * Upstream: https://github.com/JamesCowling/swaghaus · https://swaghaus.biz/
 *
 * - backend: official Convex self-host OCI (`ghcr.io/get-convex/convex-backend`)
 *   — Cloudflare Yard realizes as Workers Containers (not Convex Cloud, not laptop)
 * - auth: WorkOS AuthKit via b.external (Camp secretRef; fail-closed)
 * - web: convexApp(root) — ship pushes functions to the CF-hosted backend, then Vite
 */
export default bindle((b) => {
	const backend = b.container({
		image: "ghcr.io/get-convex/convex-backend:latest",
		endpoints: {
			api: { port: 3210 },
			httpActions: { port: 3211 },
		},
		env: {
			DISABLE_METRICS_ENDPOINT: "true",
		},
	});
	const auth = b.external({
		endpoints: { workos: "https://api.workos.com" },
	});
	const web = b
		.web(convexApp("examples/convex-swaghaus"))
		.dependsOn(backend, auth);
	return { backend, auth, web };
});
