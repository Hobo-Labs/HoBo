/**
 * Doctor check / repair / snapshot smoke tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	runDoctorCheck,
	runDoctorRepair,
	runDoctorSnapshot,
} from "../lib/doctor.mts";

describe("optimizexp doctor", () => {
	it("check finds missing optimizexp on empty root", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-doc-"));
		// minimal fake package project
		mkdirSync(path.join(root, "packages", "toy"), { recursive: true });
		writeFileSync(
			path.join(root, "packages", "toy", "package.json"),
			JSON.stringify({ name: "@toy/app", bin: { toy: "bin.js" } }),
			"utf8",
		);
		writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "root" }), "utf8");
		const report = runDoctorCheck({
			root,
			selection: {
				allProjects: false,
				projects: [
					{
						id: "toy",
						path: "packages/toy",
						kind: "package",
						label: "toy",
					},
				],
				requested: ["toy"],
				unknown: [],
			},
			deepFeatures: true,
		});
		assert.equal(report.mode, "check");
		assert.ok(
			report.findings.some((f) => f.id === "scope-missing" || f.id === "no-personas"),
		);
	});

	it("repair creates global structure and snapshot works", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-doc2-"));
		writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "root" }), "utf8");
		mkdirSync(path.join(root, "packages", "toy"), { recursive: true });
		writeFileSync(
			path.join(root, "packages", "toy", "package.json"),
			JSON.stringify({ name: "@toy/app", bin: { toy: "cli.js" } }),
			"utf8",
		);
		writeFileSync(path.join(root, "packages", "toy", "cli.js"), "console.log('hi')\n", "utf8");

		const selection = {
			allProjects: false,
			projects: [
				{
					id: "toy",
					path: "packages/toy",
					kind: "package" as const,
					label: "toy",
				},
			],
			requested: ["toy"],
			unknown: [] as string[],
		};

		const repaired = runDoctorRepair({ root, selection });
		assert.ok(repaired.repairsApplied.length > 0, "expected some repairs");
		assert.ok(
			existsSync(path.join(root, ".optimizexp")),
			"global .optimizexp should exist after repair",
		);

		const snap = runDoctorSnapshot({ root, selection });
		assert.equal(snap.mode, "snapshot");
		assert.ok(snap.snapshotPath);
		assert.ok(
			existsSync(path.join(root, snap.snapshotPath!, "doctor-report.json")) ||
				existsSync(path.join(root, snap.snapshotPath!)),
		);
		// manifest written
		const snapAbs = path.join(root, snap.snapshotPath!);
		assert.ok(existsSync(path.join(snapAbs, "manifest.json")));
		const man = JSON.parse(readFileSync(path.join(snapAbs, "manifest.json"), "utf8"));
		assert.ok(Array.isArray(man.files));
	});
});
