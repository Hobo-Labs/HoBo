import { createPostgresEventStore } from "../../src/index.js";

const store = createPostgresEventStore({
	config: {
		connectionString: process.env.HOBO_TEST_POSTGRES_URL,
		schema: process.env.HOBO_ACTOR_TEST_SCHEMA,
	},
});
await store.actorLeaseHost.acquire("deployment:crash", {
	holderId: "crashed-process",
});
process.stdout.write("LEASED\n");
await new Promise<void>(() => {});
