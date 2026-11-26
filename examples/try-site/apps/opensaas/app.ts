import { bindle } from "@hobo/bindles";
import { waspApp } from "@hobo/wasp";

/**
 * Real Open SaaS (wasp-lang/open-saas) Bindle.
 * Docs: https://docs.opensaas.sh/ · deploy env: /guides/deploying/
 *
 * - db: self-host Postgres via OCI (or swap to b.external for BYO DATABASE_URL)
 * - web: waspApp(root) — ship runs `wasp` in that directory
 *
 * Optional SaaS keys (Stripe, S3, SendGrid, …) come from camp / b.external
 * connectors; discoverWaspEnv(root) lists them from .env.*.example.
 */
export default bindle((b) => {
	const db = b.container({
		image: "postgres:16-alpine",
		endpoints: { postgres: { port: 5432 } },
		env: {
			POSTGRES_USER: "wasp",
			POSTGRES_PASSWORD: "wasp",
			POSTGRES_DB: "OpenSaaS",
		},
	});
	const web = b.web(waspApp("examples/wasp-opensaas/app")).dependsOn(db);
	return { db, web };
});
