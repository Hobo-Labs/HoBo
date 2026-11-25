import { bindle } from "@hobo/bindles";
import { waspApp } from "@hobo/wasp";

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
