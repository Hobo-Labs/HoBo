/**
 * Conformance cases for `data.postgres/v1`.
 *
 * Each case is evidence for a specific clause of the profile, not a smoke test.
 *
 * Every case here is marked `container-runtime`, including the two that only ask
 * a binary for its version: those binaries live *inside the pinned image*, so
 * running them is running the image. A `requires: "none"` case would be one whose
 * evidence needs no image at all, and this pack has none — the honest consequence
 * is that `offlineCases` is empty here and the mandatory lane exercises these
 * cases through the replay runner against recorded outcomes.
 *
 * The durability case is the one worth reading: it writes a row, restarts the
 * workload, and reads the row back. A database that passes every other case and
 * fails this one is a cache with SQL syntax.
 */
import type { PackConformanceCase } from "@hobo/pack-framework";

import { POSTGRES_SERVER_VERSION } from "./image.js";

const PSQL = [
	"psql",
	"--username=postgres",
	"--dbname=app",
	"--no-psqlrc",
	"--set=ON_ERROR_STOP=1",
];

export const POSTGRES_CONFORMANCE_CASES: readonly PackConformanceCase[] = [
	{
		id: "server-version-matches-manifest",
		profileRef: "data.postgres/v1",
		description:
			"The pinned image reports the server version the manifest advertises, so `serverVersion` in the catalog is a fact about the bytes rather than a label.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: ["postgres", "--version"],
				expectExitCode: 0,
				expectStdoutContains: POSTGRES_SERVER_VERSION,
			},
		],
	},
	{
		id: "pg-dump-present",
		profileRef: "migration.postgres.pg-dump/v1",
		description:
			"The image contains the client tooling this pack's backup and migration operations invoke; without it the export path is a promise with no implementation.",
		requires: "container-runtime",
		steps: [
			{ kind: "exec", argv: ["pg_dump", "--version"], expectExitCode: 0 },
			{ kind: "exec", argv: ["pg_restore", "--version"], expectExitCode: 0 },
		],
	},
	{
		id: "accepts-wire-protocol-connections",
		profileRef: "data.postgres/v1",
		description:
			"The declared port speaks the PostgreSQL frontend/backend protocol.",
		requires: "container-runtime",
		steps: [
			{ kind: "tcp-connect", portName: "postgres", expectReachable: true },
			{
				kind: "exec",
				argv: [...PSQL, "--command", "SELECT 1"],
				expectExitCode: 0,
				expectStdoutContains: "1",
			},
		],
	},
	{
		id: "enforces-transactions",
		profileRef: "data.relational/v1",
		description:
			"A rolled-back transaction leaves no row behind, which is the guarantee `transactions` claims.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: [
					...PSQL,
					"--command",
					"CREATE TABLE conformance_tx (id int primary key); BEGIN; INSERT INTO conformance_tx VALUES (1); ROLLBACK; SELECT count(*) FROM conformance_tx",
				],
				expectExitCode: 0,
				expectStdoutContains: "0",
			},
		],
	},
	{
		id: "enforces-declared-constraints",
		profileRef: "data.relational/v1",
		description:
			"A primary-key violation is rejected, which is the `constraints` guarantee.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: [
					...PSQL,
					"--command",
					"INSERT INTO conformance_tx VALUES (1); INSERT INTO conformance_tx VALUES (1)",
				],
				// A non-zero exit is the pass condition here.
				expectExitCode: 3,
			},
		],
	},
	{
		id: "survives-restart",
		profileRef: "data.postgres/v1",
		description:
			"A committed row is still there after the workload restarts, which is what distinguishes a persistent volume from an anonymous one.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: [
					...PSQL,
					"--command",
					"CREATE TABLE conformance_durable (id int primary key); INSERT INTO conformance_durable VALUES (42)",
				],
				expectExitCode: 0,
			},
			{
				kind: "restart-workload",
				reason: "prove the volume, not the page cache",
			},
			{
				kind: "exec",
				argv: [...PSQL, "--command", "SELECT id FROM conformance_durable"],
				expectExitCode: 0,
				expectStdoutContains: "42",
			},
		],
	},
	{
		id: "rejects-unauthenticated-connection",
		profileRef: "data.postgres/v1",
		description:
			"A connection with no password is refused, so `hostAuthMethod: scram-sha-256` is enforced rather than configured.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: [
					"psql",
					"--host=127.0.0.1",
					"--username=postgres",
					"--no-password",
					"--command=SELECT 1",
				],
				expectExitCode: 2,
			},
		],
	},
];
