import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { probeNeonManagedSession } from "../src/managed-postgres.js";

const fixture = process.env.HOBO_TEST_NEON_PG_URL_FILE;

describe("managed Neon direct PostgreSQL probe", () => {
	it.skipIf(!fixture)(
		"verifies TLS, primary access, and LISTEN on a real PostgreSQL session",
		async () => {
			if (!fixture) throw new Error("test fixture unavailable");
			const uri = new URL(readFileSync(fixture, "utf8").trim());
			await probeNeonManagedSession({
				host: uri.hostname,
				port: Number(uri.port || 5432),
				database: uri.pathname.slice(1),
				username: decodeURIComponent(uri.username),
				password: decodeURIComponent(uri.password),
			});
		},
	);
});
