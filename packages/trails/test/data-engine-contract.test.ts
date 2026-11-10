// ADR-0177 in Trails: the runbook engine imports no engine, judges live
// stores on digest evidence, and gates on a policy verdict computed over the
// custody path instead of a caller-supplied boolean.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { evaluateCustodyPath, parseCustodyPath } from "@hobo/data-core";
import {
	createSqliteDataDualPort,
	createSqliteSchemaApplyPort,
} from "@hobo/data-sqlite";
import { afterEach, describe, test } from "vitest";
import { evaluateCanTrail } from "../src/can-trail.js";
import type { DataDualPort, LiveDataDualPort } from "../src/data-dual-port.js";
import { defineTrail } from "../src/definition.js";
import {
	executeDataMigration,
	MIGRATION_EVENTS,
} from "../src/migration-executor.js";
import { TrailRunner } from "../src/runner.js";
import type { SchemaApplyPort } from "../src/schema-apply-port.js";

const NOW = "2026-11-10T00:00:00.000Z";
const LATER = "2026-11-17T00:00:00.000Z";
const FULL = [
	"encryptedAtRest",
	"encryptedInTransit",
	"accessScoped",
	"auditLogged",
];
const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-trails-engine-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function dataTrail(pattern?: "snapshot-and-tail") {
	return defineTrail({
		id: "app.orders.move",
		version: "2026.11.10.1",
		targets: ["silo-b"],
		steps: [
			{
				id: "data-dual",
				kind: "continuous-dual-data",
				data: {
					mode: "cdc-dual",
					transformId: "orders.replicate",
					checksum: `sha256:${"c".repeat(64)}`,
					...(pattern === undefined ? undefined : { pattern }),
				},
			},
		],
	});
}

describe("Trails stays engine-neutral", () => {
	test("no source file in this package imports an engine or node:sqlite", () => {
		const src = path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			"src",
		);
		const offenders = readdirSync(src)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) =>
				/from\s+["'](node:sqlite|@hobo\/data-(?!core["'])[a-z-]+)["']/u.test(
					readFileSync(path.join(src, name), "utf8"),
				),
			);
		assert.deepEqual(offenders, []);
	});

	test("an engine package's ports satisfy the Trails port shapes structurally", () => {
		const dir = tempDir();
		const dual = createSqliteDataDualPort({
			sourcePath: path.join(dir, "source.db"),
			targetPath: path.join(dir, "target.db"),
		});
		cleanups.push(() => dual.close());
		// These assignments are the proof: they compile only while the engine
		// package's ports keep the shapes Trails declares.
		const asDual: DataDualPort = dual;
		const asLive: LiveDataDualPort = dual;
		const schema = createSqliteSchemaApplyPort({
			path: path.join(dir, "schema.db"),
		});
		cleanups.push(() => schema.close());
		const asSchema: SchemaApplyPort = schema;
		assert.equal(asDual.fidelity, "live");
		assert.equal(asLive.lag(), 0);
		assert.ok(asSchema.snapshot);
	});
});

describe("the dual oracle judges evidence, not rows", () => {
	test("a port that offers digest evidence is never asked for its rows", () => {
		const dir = tempDir();
		const dual = createSqliteDataDualPort({
			sourcePath: path.join(dir, "source.db"),
			targetPath: path.join(dir, "target.db"),
		});
		cleanups.push(() => dual.close());
		dual.writeSource([
			{ id: "order-1", doc: { total: 100 } },
			{ id: "order-2", doc: { total: 250 } },
		]);
		dual.replicate();
		let rowReads = 0;
		const port: DataDualPort = {
			fidelity: "live",
			evidence: () => dual.evidence(),
			snapshot() {
				rowReads += 1;
				return dual.snapshot();
			},
		};
		const result = new TrailRunner({
			tenant: "acme",
			target: "silo-b",
			dataDual: port,
		}).run(dataTrail());
		assert.equal(result.cutover, true);
		assert.equal(rowReads, 0, "no row left the store to be judged");
		const judged = result.dataResults[0];
		assert.equal(judged?.fidelity, "live");
		assert.equal(judged?.zeroLoss, true);
		assert.match(judged?.sourceChecksum ?? "", /^sha256:[0-9a-f]{64}$/u);
	});

	test("digest evidence catches a divergence that leaves the row counts equal", () => {
		const dir = tempDir();
		const targetPath = path.join(dir, "target.db");
		const dual = createSqliteDataDualPort({
			sourcePath: path.join(dir, "source.db"),
			targetPath,
		});
		cleanups.push(() => dual.close());
		dual.writeSource([{ id: "order-1", doc: { total: 100 } }]);
		dual.replicate();
		const rogue = new DatabaseSync(targetPath);
		rogue
			.prepare("UPDATE records SET doc = ?")
			.run(JSON.stringify({ total: 1 }));
		rogue.close();
		const result = new TrailRunner({
			tenant: "acme",
			target: "silo-b",
			dataDual: dual,
		}).run(dataTrail());
		assert.equal(result.cutover, false);
		assert.equal(result.compensated, true);
		assert.equal(result.dataResults[0]?.consistent, false);
	});
});

describe("can-trail gates on a computed verdict", () => {
	const policy = {
		classification: "pii" as const,
		residency: { classifications: [], allowedJurisdictions: ["eu" as const] },
	};
	const ends = [
		{ id: "source", role: "source", region: "eu-west-1", protections: FULL },
		{ id: "target", role: "target", region: "eu-central-1", protections: FULL },
	];

	test("a relay in a denied region blocks the trail and names the custody point", () => {
		const verdict = evaluateCustodyPath({
			path: parseCustodyPath({
				points: [
					...ends,
					{
						id: "runner",
						role: "relay",
						region: "us-east-1",
						protections: FULL,
						retainUntil: LATER,
					},
				],
			}),
			policy,
			now: NOW,
		});
		// The old inputs would have passed this: both ends are in the EU.
		const result = evaluateCanTrail({
			trail: dataTrail(),
			policyAllows: true,
			residencyConflict: false,
			policyVerdict: verdict,
		});
		assert.equal(result.ok, false);
		const residency = result.reasons.find(
			(reason) => reason.code === "residency-conflict",
		);
		assert.match(residency?.message ?? "", /runner/u);
	});

	test("a rollback snapshot with weaker protection is a policy denial", () => {
		const verdict = evaluateCustodyPath({
			path: parseCustodyPath({
				points: [
					...ends,
					{
						id: "snap",
						role: "rollback-snapshot",
						region: "eu-west-1",
						protections: [],
						retainUntil: LATER,
					},
				],
			}),
			policy,
			now: NOW,
		});
		const result = evaluateCanTrail({
			trail: dataTrail(),
			policyVerdict: verdict,
		});
		assert.deepEqual(
			result.reasons.map((reason) => reason.code),
			["policy-denied"],
		);
		assert.match(result.reasons[0]?.message ?? "", /snap/u);
	});

	test("a passing verdict passes, and without a verdict the booleans still work", () => {
		const verdict = evaluateCustodyPath({
			path: parseCustodyPath({ points: ends }),
			policy,
			now: NOW,
		});
		assert.equal(
			evaluateCanTrail({ trail: dataTrail(), policyVerdict: verdict }).ok,
			true,
		);
		assert.equal(
			evaluateCanTrail({ trail: dataTrail(), residencyConflict: true }).ok,
			false,
		);
	});
});

describe("a data step may name its migration pattern", () => {
	test("the pattern is optional, validated, and part of the content hash only when present", () => {
		const without = dataTrail();
		const withPattern = dataTrail("snapshot-and-tail");
		assert.equal(withPattern.steps[0]?.data?.pattern, "snapshot-and-tail");
		assert.notEqual(without.contentHash, withPattern.contentHash);
		assert.equal(without.contentHash, dataTrail().contentHash);
		assert.throws(
			() =>
				defineTrail({
					id: "bad",
					version: "1",
					steps: [
						{
							id: "s",
							kind: "data-transform",
							data: {
								mode: "bulk",
								transformId: "t",
								checksum: `sha256:${"a".repeat(64)}`,
								// SAFETY: deliberately outside the union to exercise the parser's refusal.
								pattern: "copy-and-hope" as "offline-copy",
							},
						},
					],
				}),
			/unknown migration pattern/u,
		);
	});
});

describe("the migration executor over a real SQLite store", () => {
	function store() {
		const file = path.join(tempDir(), "app.db");
		const db = new DatabaseSync(file);
		db.exec(`
			CREATE TABLE checkout (id TEXT PRIMARY KEY, email TEXT NOT NULL);
			INSERT INTO checkout VALUES ('1', 'a@example.test'), ('2', 'b@example.test');
		`);
		db.close();
		const port = createSqliteSchemaApplyPort({ path: file, clock: () => NOW });
		cleanups.push(() => port.close());
		return { port, file };
	}

	const plan = {
		migrationId: "checkout-pseudonymise",
		expand: ["ALTER TABLE checkout ADD COLUMN requester_ref TEXT"],
		backfill: ["UPDATE checkout SET requester_ref = 'ref:' || id"],
		contract: ["ALTER TABLE checkout DROP COLUMN email"],
		verify: {
			afterBackfill: "SELECT id FROM checkout WHERE requester_ref IS NULL",
		},
	};
	const gate = () => ({
		gateId: "g",
		consumersOnLegacySchema: [],
		verifiedAt: NOW,
	});

	test("a negative verdict before the destructive phase holds with the dual window open", async () => {
		const { port, file } = store();
		const result = await executeDataMigration({
			port,
			plan,
			compatGate: gate,
			clock: () => NOW,
			policy: (phase) => ({
				ok: phase !== "contract",
				findings:
					phase === "contract" ? [{ code: "CUSTODY_RETENTION_EXPIRED" }] : [],
			}),
		});
		assert.equal(result.status, "held");
		assert.equal(result.dualWindowOpen, true);
		assert.ok(result.facts.some((fact) => fact.type === MIGRATION_EVENTS.Held));
		port.close();
		cleanups.pop();
		const db = new DatabaseSync(file);
		const row = db
			.prepare("SELECT email, requester_ref FROM checkout WHERE id = '1'")
			.get();
		db.close();
		assert.deepEqual(
			{ ...row },
			{ email: "a@example.test", requester_ref: "ref:1" },
		);
	});

	test("a failed phase restores the snapshot and re-applies erasures", async () => {
		const { port } = store();
		let replayedFor = "";
		const result = await executeDataMigration({
			port,
			plan: {
				...plan,
				contract: ["ALTER TABLE checkout DROP COLUMN no_such_column"],
			},
			compatGate: gate,
			clock: () => NOW,
			replayErasures: (snapshot) => {
				replayedFor = snapshot.ref;
				return 2;
			},
		});
		assert.equal(result.status, "rolled-back");
		assert.equal(replayedFor, result.snapshot?.ref);
		const rolled = result.facts.find(
			(fact) => fact.type === MIGRATION_EVENTS.RolledBack,
		);
		assert.equal(rolled?.data.erasuresReplayed, 2);
		// The restored store has the original schema: the expand is gone too.
		assert.equal(
			port.verify(
				"SELECT 1 FROM pragma_table_info('checkout') WHERE name = 'requester_ref'",
			).length,
			0,
		);
	});
});
