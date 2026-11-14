import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createPgPool } from "../src/index.js";
import {
	adminQuery,
	describeLive,
	freshSchema,
	liveStore,
	POSTGRES_URL,
} from "./support/live.js";

function roleUrl(role: string, password: string): string {
	// Preserve the fixture's TLS and Unix-socket options when switching roles.
	if (!/^postgres(?:ql)?:\/\//u.test(POSTGRES_URL)) {
		throw new Error("PostgreSQL test URL must be a PostgreSQL URI");
	}
	return POSTGRES_URL.replace(
		/^(postgres(?:ql)?:\/\/)(?:[^/@]*@)?/u,
		`$1${role}:${password}@`,
	);
}

describeLive("PostgreSQL application role isolation", () => {
	it("proves the app cannot modify journal state or assume a writer role", async () => {
		const schema = freshSchema();
		const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
		const applicationRole = `hobo_app_${suffix}`;
		const inheritedRole = `hobo_inherit_${suffix}`;
		const password = `hobo_test_${suffix}`;
		const store = liveStore({
			schema,
			protectedActorStreamPrefixes: ["ci-queue:"],
		});
		await store.ready();
		await adminQuery(
			`CREATE ROLE "${applicationRole}" LOGIN PASSWORD '${password}'`,
		);
		await adminQuery(`CREATE ROLE "${inheritedRole}" NOLOGIN`);
		const applicationPool = createPgPool({
			...store.config,
			connectionString: roleUrl(applicationRole, password),
			poolSize: 1,
		});
		try {
			await adminQuery(
				`GRANT USAGE ON SCHEMA "${schema}" TO "${applicationRole}"`,
			);
			await adminQuery(
				`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${applicationRole}"`,
			);
			const proof = await store.verifyApplicationRoleIsolation({
				applicationRole,
				protectedPrefix: "ci-queue:",
				applicationPool,
			});
			expect(proof).toMatchObject({ applicationRole, schema });
			expect(proof.supervisorRole).not.toBe(applicationRole);
			await adminQuery(
				`ALTER TABLE "${schema}".actor_commit_checks DISABLE TRIGGER actor_commit_lease_live`,
			);
			try {
				await expect(
					store.verifyApplicationRoleIsolation({
						applicationRole,
						protectedPrefix: "ci-queue:",
						applicationPool,
					}),
				).rejects.toThrow(/actor commit lease protection/u);
			} finally {
				await adminQuery(
					`ALTER TABLE "${schema}".actor_commit_checks ENABLE TRIGGER actor_commit_lease_live`,
				);
			}
			const supervisorPool = createPgPool({ ...store.config, poolSize: 1 });
			try {
				await expect(
					store.verifyApplicationRoleIsolation({
						applicationRole,
						protectedPrefix: "ci-queue:",
						applicationPool: supervisorPool,
					}),
				).rejects.toThrow(/application credential/u);
			} finally {
				await supervisorPool.end();
			}
			const client = await applicationPool.connect();
			try {
				await expect(
					client.query(
						`INSERT INTO "${schema}".streams (stream_id, revision, owner_epoch, created_at, updated_at) VALUES ('ci-queue:foreign',0,0,'x','x')`,
					),
				).rejects.toMatchObject({ code: "42501" });
				await expect(
					client.query(
						`UPDATE "${schema}".actor_lease_policy SET prefixes = '[]'`,
					),
				).rejects.toMatchObject({ code: "42501" });
				await expect(
					client.query(
						`SET ROLE "${proof.supervisorRole.replaceAll('"', '""')}"`,
					),
				).rejects.toMatchObject({ code: "42501" });
			} finally {
				client.release();
			}

			await adminQuery(
				`GRANT INSERT ON "${schema}".events TO "${applicationRole}"`,
			);
			await expect(
				store.verifyApplicationRoleIsolation({
					applicationRole,
					protectedPrefix: "ci-queue:",
					applicationPool,
				}),
			).rejects.toThrow(/bypass/u);
			await adminQuery(
				`REVOKE INSERT ON "${schema}".events FROM "${applicationRole}"`,
			);
			await adminQuery(
				`GRANT UPDATE (revision) ON "${schema}".streams TO "${applicationRole}"`,
			);
			await expect(
				store.verifyApplicationRoleIsolation({
					applicationRole,
					protectedPrefix: "ci-queue:",
					applicationPool,
				}),
			).rejects.toThrow(/bypass/u);
			await adminQuery(
				`REVOKE UPDATE (revision) ON "${schema}".streams FROM "${applicationRole}"`,
			);
			await adminQuery(`GRANT DELETE ON "${schema}".events TO PUBLIC`);
			await expect(
				store.verifyApplicationRoleIsolation({
					applicationRole,
					protectedPrefix: "ci-queue:",
					applicationPool,
				}),
			).rejects.toThrow(/bypass/u);
			await adminQuery(`REVOKE DELETE ON "${schema}".events FROM PUBLIC`);

			await adminQuery(
				`GRANT UPDATE ON "${schema}".streams TO "${inheritedRole}"`,
			);
			await adminQuery(`ALTER ROLE "${applicationRole}" NOINHERIT`);
			await adminQuery(`GRANT "${inheritedRole}" TO "${applicationRole}"`);
			await expect(
				store.verifyApplicationRoleIsolation({
					applicationRole,
					protectedPrefix: "ci-queue:",
					applicationPool,
				}),
			).rejects.toThrow(/bypass/u);
			await adminQuery(`REVOKE "${inheritedRole}" FROM "${applicationRole}"`);

			await adminQuery(
				`GRANT CREATE ON SCHEMA "${schema}" TO "${applicationRole}"`,
			);
			await expect(
				store.verifyApplicationRoleIsolation({
					applicationRole,
					protectedPrefix: "ci-queue:",
					applicationPool,
				}),
			).rejects.toThrow(/bypass/u);
			await adminQuery(
				`REVOKE CREATE ON SCHEMA "${schema}" FROM "${applicationRole}"`,
			);

			await adminQuery(
				`CREATE FUNCTION "${schema}".unsafe_application_test() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
			);
			await expect(
				store.verifyApplicationRoleIsolation({
					applicationRole,
					protectedPrefix: "ci-queue:",
					applicationPool,
				}),
			).rejects.toThrow(/bypass/u);
			await adminQuery(`DROP FUNCTION "${schema}".unsafe_application_test()`);
			await expect(
				store.verifyApplicationRoleIsolation({
					applicationRole,
					protectedPrefix: "ci-queue:",
					applicationPool,
				}),
			).resolves.toMatchObject({ applicationRole });
		} finally {
			await applicationPool.end();
			await adminQuery(`DROP OWNED BY "${applicationRole}"`);
			await adminQuery(`DROP OWNED BY "${inheritedRole}"`);
			await adminQuery(`DROP ROLE "${applicationRole}"`);
			await adminQuery(`DROP ROLE "${inheritedRole}"`);
		}
	});

	it("verifies separate non-superuser supervisor and application sessions", async () => {
		const schema = freshSchema();
		const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
		const supervisorRole = `hobo_supervisor_${suffix}`;
		const applicationRole = `hobo_client_${suffix}`;
		const password = `hobo_test_${suffix}`;
		await adminQuery(
			`CREATE ROLE "${supervisorRole}" LOGIN PASSWORD '${password}'`,
		);
		await adminQuery(
			`CREATE ROLE "${applicationRole}" LOGIN PASSWORD '${password}'`,
		);
		await adminQuery(`GRANT pg_read_all_stats TO "${supervisorRole}"`);
		await adminQuery(
			`DO $test$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), '${supervisorRole}'); END $test$`,
		);
		await adminQuery(
			`CREATE SCHEMA "${schema}" AUTHORIZATION "${supervisorRole}"`,
		);
		const store = liveStore({
			schema,
			config: { connectionString: roleUrl(supervisorRole, password) },
			protectedActorStreamPrefixes: ["ci-queue:"],
		});
		const applicationPool = createPgPool({
			...store.config,
			connectionString: roleUrl(applicationRole, password),
			poolSize: 1,
		});
		try {
			await store.ready();
			await adminQuery(
				`GRANT USAGE ON SCHEMA "${schema}" TO "${applicationRole}"`,
			);
			await adminQuery(
				`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${applicationRole}"`,
			);
			await expect(
				store.verifyApplicationRoleIsolation({
					applicationRole,
					protectedPrefix: "ci-queue:",
					applicationPool,
				}),
			).resolves.toMatchObject({ applicationRole, supervisorRole, schema });
		} finally {
			await applicationPool.end();
			await store.end();
			await adminQuery(`DROP SCHEMA "${schema}" CASCADE`);
			await adminQuery(`DROP OWNED BY "${applicationRole}"`);
			await adminQuery(`DROP OWNED BY "${supervisorRole}"`);
			await adminQuery(`DROP ROLE "${applicationRole}"`);
			await adminQuery(`DROP ROLE "${supervisorRole}"`);
		}
	});
});
