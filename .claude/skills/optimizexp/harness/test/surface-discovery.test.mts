import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	buildExperienceCatalog,
	validateCatalogCoverage,
	writeExperienceCatalog,
} from "../lib/experience-catalog.mts";
import {
	buildSurfaceMap,
	surfaceMapDigest,
	validateSurfaceMap,
	writeSurfaceMap,
	type SurfaceMap,
} from "../lib/surface-map.mts";
import { runDoctorCheck, runDoctorRepair } from "../lib/doctor.mts";

const project = {
	id: "sample",
	path: "project",
	kind: "package" as const,
	label: "sample",
};

function fixture(run: (root: string, dir: string) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "hobo-surface-discovery-"));
	const dir = path.join(root, "project");
	mkdirSync(path.join(dir, "bin"), { recursive: true });
	try {
		run(root, dir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function packageWithBin(dir: string): void {
	writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: "sample",
			bin: { sample: "bin/sample.mjs" },
		}),
	);
}

describe("surface discovery", () => {
	it("does not infer a TTY from ordinary words or invent unobserved verbs", () => {
		fixture((root, dir) => {
			packageWithBin(dir);
			writeFileSync(
				path.join(dir, "README.md"),
				"Capabilities and pipelines are documented here.\n",
			);
			const map = buildSurfaceMap({ project, root, skipProbes: true });
			assert.equal(map.defaultEntry?.interactive, false);
			assert.deepEqual(map.interactiveSurfaces, []);
			assert.deepEqual(map.commands, []);
			assert.equal(map.nonInteractiveHelp, null);
			assert.ok(
				validateSurfaceMap(map).includes("commands empty despite binaries"),
			);
			assert.ok(validateSurfaceMap(map).includes("package CLI help is unverified"));
		});
	});

	it("recognizes an explicit interactive TTY only for a project with a binary", () => {
		fixture((root, dir) => {
			writeFileSync(
				path.join(dir, "README.md"),
				"The default is an interactive TTY.\n",
			);
			assert.deepEqual(
				buildSurfaceMap({ project, root, skipProbes: true })
					.interactiveSurfaces,
				[],
			);
			packageWithBin(dir);
			const map = buildSurfaceMap({ project, root, skipProbes: true });
			assert.equal(map.defaultEntry?.interactive, true);
			assert.deepEqual(map.interactiveSurfaces[0]?.slashCommands, []);
		});
	});

	it("does not infer the default TTY from a secondary binary or a negated claim", () => {
		fixture((root, dir) => {
			writeFileSync(path.join(dir, "package.json"), JSON.stringify({
				name: "sample", bin: { sample: "bin/sample.mjs", other: "bin/other.mjs" },
			}));
			writeFileSync(path.join(dir, "bin/sample.mjs"), "console.log('usage');\n");
			writeFileSync(path.join(dir, "bin/other.mjs"), "launchPi();\n");
			writeFileSync(path.join(dir, "README.md"), "The default is not an interactive TTY.\n");
			const map = buildSurfaceMap({ project, root, skipProbes: true });
			assert.equal(map.defaultEntry?.interactive, false);
			assert.deepEqual(map.interactiveSurfaces, []);
		});
	});

	it("discovers commands from the successful declared binary's help", () => {
		fixture((root, dir) => {
			packageWithBin(dir);
			writeFileSync(
				path.join(dir, "bin/sample.mjs"),
				'process.stdout.write("  up       Start the app\\n  plan     Preview changes\\n");\n',
			);
			const map = buildSurfaceMap({ project, root, probeBinary: true });
			assert.equal(map.probes[0]?.exitCode, 0);
			assert.equal(map.nonInteractiveHelp?.command, "sample --help");
			assert.deepEqual(
				map.commands.map((command) => command.id),
				["up", "plan"],
			);
		});
	});

	it("does not treat failed help output or a missing binary as evidence", () => {
		fixture((root, dir) => {
			packageWithBin(dir);
			const fallbackDir = path.join(root, "fallback");
			const marker = path.join(root, "fallback-ran");
			mkdirSync(fallbackDir);
			const fallback = path.join(fallbackDir, "sample");
			writeFileSync(fallback, '#!/bin/sh\nprintf called > "$HOBO_FOLLOWUP_MARKER"\n');
			chmodSync(fallback, 0o755);
			const oldPath = process.env.PATH;
			const oldMarker = process.env.HOBO_FOLLOWUP_MARKER;
			process.env.PATH = fallbackDir;
			process.env.HOBO_FOLLOWUP_MARKER = marker;
			let missing: SurfaceMap;
			try {
				missing = buildSurfaceMap({ project, root, probeBinary: true });
			} finally {
				if (oldPath === undefined) delete process.env.PATH;
				else process.env.PATH = oldPath;
				if (oldMarker === undefined) delete process.env.HOBO_FOLLOWUP_MARKER;
				else process.env.HOBO_FOLLOWUP_MARKER = oldMarker;
			}
			assert.equal(existsSync(marker), false);
			assert.equal(missing.probes[0]?.exitCode, null);
			assert.match(missing.probes[0]?.notes ?? "", /not built/);
			assert.equal(missing.nonInteractiveHelp, null);
			assert.deepEqual(missing.commands, []);
			writeFileSync(
				path.join(dir, "bin/sample.mjs"),
				'process.stdout.write("  status     misleading output\\n"); process.exit(2);\n',
			);
			const failed = buildSurfaceMap({ project, root, probeBinary: true });
			assert.equal(failed.probes[0]?.exitCode, 2);
			assert.equal(failed.nonInteractiveHelp, null);
			assert.deepEqual(failed.commands, []);
		});
	});

	it("distinguishes no declared package bin from a missing or malformed manifest", () => {
		fixture((root, dir) => {
			const missing = buildSurfaceMap({ project, root, skipProbes: true });
			assert.equal(missing.cliAssessment?.status, "unverified");
			assert.ok(
				validateSurfaceMap(missing).some((problem) =>
					problem.includes("unverified"),
				),
			);
			writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "sample" }),
			);
			const noBin = buildSurfaceMap({ project, root, skipProbes: true });
			assert.equal(noBin.cliAssessment?.status, "not-applicable");
			assert.match(
				noBin.cliAssessment?.evidence ?? "",
				/package\.json: no package bin/,
			);
			assert.deepEqual(validateSurfaceMap(noBin), []);
			writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "sample", bin: { sample: 42 } }),
			);
			const malformed = buildSurfaceMap({ project, root, skipProbes: true });
			assert.equal(malformed.cliAssessment?.status, "unverified");
			assert.ok(
				validateSurfaceMap(malformed).some((problem) =>
					problem.includes("unverified"),
				),
			);
		});
	});

	it("reports scoped non-applicability, but never silently passes unknown or stale manifests", () => {
		fixture((root, dir) => {
			const selection = {
				allProjects: false,
				projects: [project],
				requested: ["sample"],
				unknown: [],
			};
			const noMap = runDoctorCheck({ root, selection });
			assert.ok(noMap.findings.some((finding) => finding.id === "surface-map-missing" && finding.severity === "error" && /unverified/.test(finding.message)));
			writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "sample" }),
			);
			const map = buildSurfaceMap({ project, root, skipProbes: true });
			writeSurfaceMap(map, project, root);
			writeExperienceCatalog(
				buildExperienceCatalog({ project, root, surfaceMap: map }),
				project,
				root,
			);
			const valid = runDoctorCheck({ root, selection });
			assert.ok(
				valid.findings.some(
					(finding) =>
						finding.id === "no-binaries" &&
						/Other CLI and non-CLI surfaces are not assessed/.test(
							finding.message,
						),
				),
			);
			writeFileSync(path.join(dir, "package.json"), "not json");
			const stale = runDoctorCheck({ root, selection });
			assert.ok(
				stale.findings.some(
					(finding) =>
						finding.id === "surface-map-invalid" &&
						/stale/.test(finding.message),
				),
			);
			assert.ok(
				!stale.findings.some((finding) => finding.id === "no-binaries"),
			);
			const unknown = buildSurfaceMap({ project, root, skipProbes: true });
			writeSurfaceMap(unknown, project, root);
			writeExperienceCatalog(
				buildExperienceCatalog({ project, root, surfaceMap: unknown }),
				project,
				root,
			);
			const unchecked = runDoctorCheck({ root, selection });
			assert.ok(
				unchecked.findings.some(
					(finding) =>
						finding.id === "surface-map-invalid" &&
						/unverified/.test(finding.message),
				),
			);
		});
	});
});

describe("persona experience selection", () => {
	it("never invents a CLI or persona verbs absent from the mapped surface", () => {
		fixture((root) => {
			const personas = path.join(root, ".optimizexp/personas");
			mkdirSync(personas, { recursive: true });
			writeFileSync(
				path.join(personas, "cursor-user.md"),
				"cursor harness config cost tasks\n",
			);
			const empty: SurfaceMap = {
				schemaVersion: 1,
				projectId: "sample",
				scannedAt: "",
				productName: "sample",
				packageDir: "project",
				binaries: [],
				defaultEntry: null,
				nonInteractiveHelp: null,
				commands: [],
				interactiveSurfaces: [],
				requiredJourneys: [],
				probes: [],
			};
			const noCli = buildExperienceCatalog({
				project,
				root,
				personaIds: ["cursor-user"],
				surfaceMap: empty,
			});
			assert.deepEqual(noCli.experiences, []);
			assert.match(validateCatalogCoverage(noCli, [], empty)[0] ?? "", /unverified/);
			const notApplicable: SurfaceMap = {
				...empty,
				cliAssessment: {
					status: "not-applicable",
					scope: "package.json bin",
					evidence: "project/package.json: no package bin is declared",
				},
			};
			const library = buildExperienceCatalog({
				project,
				root,
				personaIds: ["cursor-user"],
				surfaceMap: notApplicable,
			});
			assert.deepEqual(validateCatalogCoverage(library, ["cursor-user"], notApplicable), []);
			assert.equal(library.cliAssessment?.status, "not-applicable");
			const cli: SurfaceMap = {
				...empty,
				cliAssessment: {
					status: "present",
					scope: "package.json bin",
					evidence: "project/package.json: declares sample",
				},
				binaries: [{ name: "sample", binPath: "/sample" }],
				binAssessments: [{ name: "sample", status: "observed-help", evidence: "fixture help" }],
				probes: [{ binName: "sample", kind: "help", command: "sample --help", exitCode: 0, stdoutDigest: "fixture", capturedAt: "fixture" }],
				defaultEntry: {
					command: "sample",
					interactive: false,
					driver: "cli",
					notes: "test",
				},
				nonInteractiveHelp: { command: "sample --help", driver: "cli" },
				commands: [{ id: "config", argv: ["config"], kind: "verb" }],
				requiredJourneys: ["default-entry-cold-start"],
			};
			const known = buildExperienceCatalog({
				project,
				root,
				personaIds: ["cursor-user"],
				surfaceMap: cli,
			});
			assert.ok(
				known.experiences.some(
					(entry) => entry.entryCommand === "sample config",
				),
			);
			assert.ok(
				known.experiences.some(
					(entry) => entry.entryCommand === "sample --help",
				),
			);
			assert.ok(
				known.experiences.every(
					(entry) =>
						!/sample (guide|harness|cost|tasks)/.test(entry.entryCommand),
				),
			);
			const withGuide: SurfaceMap = {
				...cli,
				commands: [
					...cli.commands,
					{ id: "guide", argv: ["guide", "--cursor"], kind: "verb" },
				],
			};
			const guided = buildExperienceCatalog({
				project,
				root,
				personaIds: ["cursor-user"],
				surfaceMap: withGuide,
			});
			assert.ok(
				guided.experiences.some(
					(entry) => entry.entryCommand === "sample guide --cursor",
				),
			);
		});
	});

	it("exploration validation refuses stale maps", () => {
		fixture((root) => {
			mkdirSync(path.join(root, ".git"));
			const dir = path.join(root, "packages/hobo");
			mkdirSync(dir, { recursive: true });
			const hobo = {
				id: "hobo",
				path: "packages/hobo",
				kind: "package" as const,
				label: "hobo",
			};
			writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "@hobo/hobo" }),
			);
			const map = buildSurfaceMap({ project: hobo, root, skipProbes: true });
			writeSurfaceMap(map, hobo, root);
			writeExperienceCatalog(
				buildExperienceCatalog({ project: hobo, root, surfaceMap: map }),
				hobo,
				root,
			);
			writeFileSync(path.join(dir, "package.json"), "not json");
			const explorer = fileURLToPath(new URL("../explore-app.mts", import.meta.url));
			const validation = spawnSync(process.execPath, [explorer, "--mode", "validate", "--project", "hobo"], { cwd: root, encoding: "utf8" });
			assert.equal(validation.status, 1, validation.stderr);
			assert.match(validation.stdout, /assessment is stale/);
		});
	});
});

describe("discovery evidence boundaries", () => {
	it("rejects missing or invalid projects before writing and supports existing package fallback", () => {
		fixture((root) => {
			mkdirSync(path.join(root, ".git"));
			const packages = path.join(root, "packages");
			const known = path.join(packages, "hobo");
			const retained = path.join(packages, "retained");
			const invalid = path.join(packages, "invalid");
			for (const dir of [known, retained, invalid]) mkdirSync(dir, { recursive: true });
			writeFileSync(path.join(known, "package.json"), JSON.stringify({ name: "hobo" }));
			writeFileSync(path.join(retained, "package.json"), JSON.stringify({ name: "retained" }));
			writeFileSync(path.join(invalid, "package.json"), "not json");
			const outside = path.join(root, "outside");
			mkdirSync(outside);
			writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "outside" }));
			symlinkSync(outside, path.join(packages, "escape"));
			const explorer = fileURLToPath(new URL("../explore-app.mts", import.meta.url));
			const run = (...args: string[]) => spawnSync(process.execPath, [explorer, ...args], { cwd: root, encoding: "utf8" });
			const missing = run("--project", "code");
			assert.equal(missing.status, 2, missing.stderr);
			assert.match(missing.stderr, /Unknown or invalid project/);
			assert.equal(existsSync(path.join(packages, "code")), false);
			assert.equal(run("--project", "packages/code").status, 2);
			assert.equal(existsSync(path.join(packages, "code")), false);
			assert.equal(run("--project", "hobo,code").status, 2);
			assert.equal(run("--project", "all,code").status, 2);
			assert.equal(existsSync(path.join(known, ".optimizexp")), false);
			assert.equal(run("--project", "invalid").status, 2);
			assert.equal(existsSync(path.join(invalid, ".optimizexp")), false);
			assert.equal(run("--project", "packages/../outside").status, 2);
			assert.equal(run("--project", "escape").status, 2);
			assert.equal(existsSync(path.join(outside, ".optimizexp")), false);
			assert.equal(run("--project").status, 2);
			assert.equal(run("--project", " , ").status, 2);
			const valid = run("--project", "packages/retained");
			assert.equal(valid.status, 0, valid.stderr);
			assert.equal(existsSync(path.join(retained, ".optimizexp/surface-map.json")), true);
			assert.match(run("--help").stdout, /e\.g\. hobo, site, cli/);
		});
	});

	it("requires opt-in before executing a binary and ignores unrelated verb arrays", () => {
		fixture((root, dir) => {
			packageWithBin(dir);
			const marker = path.join(root, "ran");
			mkdirSync(path.join(dir, "src"));
			writeFileSync(path.join(dir, "src/unrelated.ts"), 'const HOBO_UNUSED_VERBS = ["status"] as const;\n');
			writeFileSync(path.join(dir, "bin/sample.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nconsole.log("  up       Start app");\n`);
			const unprobed = buildSurfaceMap({ project, root });
			assert.equal(existsSync(marker), false);
			assert.deepEqual(unprobed.commands, []);
			assert.match(validateSurfaceMap(unprobed).join("; "), /binary sample is unverified/);
			const probed = buildSurfaceMap({ project, root, probeBinary: true });
			assert.equal(existsSync(marker), true);
			assert.deepEqual(probed.commands.map((entry) => entry.id), ["up"]);
			assert.deepEqual(validateSurfaceMap(probed), []);
			const catalog = buildExperienceCatalog({ project, root, personaIds: ["herdr"], surfaceMap: probed });
			assert.ok(!catalog.experiences.some((entry) => entry.entryCommand === "sample status"));
		});
	});

	it("requires explicit CLI opt-in before running project code", () => {
		fixture((root) => {
			mkdirSync(path.join(root, ".git"));
			const dir = path.join(root, "packages/hobo");
			mkdirSync(path.join(dir, "bin"), { recursive: true });
			writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "hobo", bin: { hobo: "bin/hobo.mjs" } }));
			const marker = path.join(root, "cli-probe-ran");
			writeFileSync(path.join(dir, "bin/hobo.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); console.log("  up       Start app");\n`);
			const explorer = fileURLToPath(new URL("../explore-app.mts", import.meta.url));
			const run = (flags: string[]) => spawnSync(process.execPath, [explorer, "--project", "hobo", ...flags], { cwd: root, encoding: "utf8" });
			assert.equal(run([]).status, 1);
			assert.equal(existsSync(marker), false);
			const optedIn = run(["--probe-bin"]);
			assert.equal(optedIn.status, 0, optedIn.stderr);
			assert.equal(existsSync(marker), true);
		});
	});

	it("marks additional package bins unverified without running them", () => {
		fixture((root, dir) => {
			writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sample", bin: { sample: "bin/sample.mjs", "sample-mcp": "bin/mcp.mjs" } }));
			writeFileSync(path.join(dir, "bin/sample.mjs"), 'console.log("  up       Start app");\n');
			const marker = path.join(root, "mcp-ran");
			writeFileSync(path.join(dir, "bin/mcp.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
			const map = buildSurfaceMap({ project, root, probeBinary: true });
			assert.equal(existsSync(marker), false);
			assert.deepEqual(map.binAssessments?.map(({ name, status }) => [name, status]), [["sample", "observed-help"], ["sample-mcp", "unverified"]]);
			assert.match(validateSurfaceMap(map).join("; "), /binary sample-mcp is unverified/);
			const catalog = buildExperienceCatalog({ project, root, surfaceMap: map });
			assert.match(validateCatalogCoverage(catalog, [], map).join("; "), /binary sample-mcp is unverified/);
			const claimedSecondary: SurfaceMap = {
				...map,
				binAssessments: map.binAssessments?.map((assessment) => assessment.name === "sample-mcp" ? { ...assessment, status: "observed-help", evidence: "claimed help" } : assessment),
				probes: [...map.probes, { binName: "sample-mcp", kind: "help", command: "sample-mcp --help", exitCode: 0, stdoutDigest: "fixture", capturedAt: "fixture" }],
			};
			assert.match(validateSurfaceMap(claimedSecondary).join("; "), /secondary-bin journeys are not assessed/);
		});
	});

	it("allows an explicitly primary-only catalog without claiming secondary experiences", () => {
		fixture((root, dir) => {
			writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sample", bin: { sample: "bin/sample.mjs", "sample-mcp": "bin/mcp.mjs" } }));
			writeFileSync(path.join(dir, "bin/sample.mjs"), 'console.log("  up       Start app");\n');
			const marker = path.join(root, "mcp-ran");
			writeFileSync(path.join(dir, "bin/mcp.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
			const unprobed = buildSurfaceMap({ project, root, primaryBinOnly: true });
			assert.match(validateSurfaceMap(unprobed).join("; "), /binary sample is unverified/);
			const map = buildSurfaceMap({ project, root, probeBinary: true, primaryBinOnly: true });
			assert.equal(existsSync(marker), false);
			assert.equal(map.coverageScope, "primary-bin");
			assert.equal(map.binAssessments?.[1]?.status, "unverified");
			assert.deepEqual(validateSurfaceMap(map), []);
			const catalog = buildExperienceCatalog({ project, root, personaIds: ["developer"], surfaceMap: map });
			assert.deepEqual(validateCatalogCoverage(catalog, ["developer"], map, { root, freshProbe: true }), []);
			assert.match(validateCatalogCoverage(catalog, ["developer"], map, { root }).join("; "), /confirm-surface-current/);
			const secondary = { ...catalog.experiences[0]!, experienceId: "secondary", entryCommand: "sample-mcp --help" };
			catalog.experiences.push(secondary);
			assert.match(validateCatalogCoverage(catalog, ["developer"], map, { root, freshProbe: true }).join("; "), /outside primary-bin scope/);
			secondary.entryCommand = "sh -c sample-mcp";
			assert.match(validateCatalogCoverage(catalog, ["developer"], map, { root, freshProbe: true }).join("; "), /outside primary-bin scope/);
			const badDefault = { ...map, defaultEntry: { ...map.defaultEntry!, command: "sample-mcp" } };
			assert.match(validateSurfaceMap(badDefault).join("; "), /primary binary/);
			const badVerb = { ...map, commands: [{ id: "up", argv: ["up;sample-mcp"], kind: "verb" }] };
			assert.match(validateSurfaceMap(badVerb).join("; "), /single observed verbs/);
			const badAssessment: SurfaceMap = { ...map, binAssessments: map.binAssessments?.map((item) => item.name === "sample-mcp" ? { ...item, status: "observed-help" } : item) };
			assert.match(validateSurfaceMap(badAssessment).join("; "), /must remain unverified/);
		});
	});

	it("exposes the primary-only scope through exploration and doctor", () => {
		fixture((root) => {
			mkdirSync(path.join(root, ".git"));
			const dir = path.join(root, "packages/hobo");
			mkdirSync(path.join(dir, "bin"), { recursive: true });
			mkdirSync(path.join(root, ".optimizexp/personas"), { recursive: true });
			writeFileSync(path.join(root, ".optimizexp/personas/developer.md"), '---\nid: developer\nexperiences: [dx]\ninterfaces: [cli]\n---\nInspect the CLI.\n');
			writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "hobo", bin: { hobo: "bin/hobo.mjs", "hobo-mcp": "bin/mcp.mjs" } }));
			writeFileSync(path.join(dir, "bin/hobo.mjs"), 'console.log("  up       Start app");\n');
			const marker = path.join(root, "mcp-ran");
			writeFileSync(path.join(dir, "bin/mcp.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
			const explorer = fileURLToPath(new URL("../explore-app.mts", import.meta.url));
			const run = (args: string[]) => spawnSync(process.execPath, [explorer, "--project", "hobo", ...args], { cwd: root, encoding: "utf8" });
			const result = run(["--probe-bin", "--primary-bin-only"]);
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.match(JSON.parse(result.stdout).coverageScope, /secondary binaries.*not assessed/);
			assert.equal(existsSync(marker), false);
			const output = path.join(dir, ".optimizexp");
			const map = JSON.parse(readFileSync(path.join(output, "surface-map.json"), "utf8")) as SurfaceMap;
			const confirmation = `hobo:${surfaceMapDigest(map)}`;
			assert.equal(run(["--mode", "validate"]).status, 1);
			assert.equal(run(["--mode", "validate", `--confirm-surface-current=${confirmation}`]).status, 0);
			assert.equal(run(["--mode", "validate", "--primary-bin-only"]).status, 2);
			const hobo = { id: "hobo", path: "packages/hobo", kind: "package" as const, label: "hobo" };
			const report = runDoctorCheck({ root, selection: { allProjects: false, projects: [hobo], requested: ["hobo"], unknown: [] }, confirmedSurfaces: [confirmation] });
			assert.ok(report.findings.some((finding) => finding.id === "surface-scope" && finding.severity === "warn" && /secondary binaries/.test(finding.message)));
			const doctor = fileURLToPath(new URL("../doctor.mts", import.meta.url));
			const repaired = spawnSync(process.execPath, [doctor, "repair", "--project", "hobo", "--only", "build-surface-map", "--json", `--confirm-surface-current=${confirmation}`], { cwd: root, encoding: "utf8" });
			assert.ok(!JSON.parse(repaired.stdout).findings.some((finding: { message: string }) => /confirm-surface-current/.test(finding.message)));
			const snapshot = (name: string, flags: string[]) => spawnSync(process.execPath, [doctor, "snapshot", "--project", "hobo", "--out", path.join(root, name), "--json", ...flags], { cwd: root, encoding: "utf8" });
			const unconfirmedSnapshot = snapshot("snapshot-unconfirmed", []);
			assert.ok(JSON.parse(unconfirmedSnapshot.stdout).findings.some((finding: { message: string }) => /confirm-surface-current/.test(finding.message)));
			const confirmedSnapshot = snapshot("snapshot-confirmed", [`--confirm-surface-current=${confirmation}`]);
			assert.ok(!JSON.parse(confirmedSnapshot.stdout).findings.some((finding: { message: string }) => /confirm-surface-current/.test(finding.message)));
			assert.ok(!JSON.parse(readFileSync(path.join(root, "snapshot-confirmed/doctor-report.json"), "utf8")).findings.some((finding: { message: string }) => /confirm-surface-current/.test(finding.message)));
			writeFileSync(path.join(dir, "bin/hobo.mjs"), 'console.log("changed");\n');
			const staleSnapshot = snapshot("snapshot-stale", [`--confirm-surface-current=${confirmation}`]);
			assert.ok(JSON.parse(staleSnapshot.stdout).findings.some((finding: { message: string }) => /executable changed/.test(finding.message)));
		});
	});

	it("preserves saved observations and catalogs during repair and creates only a missing map", () => {
		fixture((root, dir) => {
			packageWithBin(dir);
			const marker = path.join(root, "ran");
			writeFileSync(path.join(dir, "bin/sample.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); console.log("  up       Start app");\n`);
			const map = buildSurfaceMap({ project, root, probeBinary: true });
			const catalog = buildExperienceCatalog({ project, root, personaIds: ["developer"], surfaceMap: map });
			writeSurfaceMap(map, project, root);
			writeExperienceCatalog(catalog, project, root);
			const mapPath = path.join(dir, ".optimizexp/surface-map.json");
			const catalogPath = path.join(dir, ".optimizexp/experience-catalog.json");
			const originalMap = readFileSync(mapPath, "utf8");
			const originalCatalog = readFileSync(catalogPath, "utf8");
			const selection = { allProjects: false, projects: [project], requested: ["sample"], unknown: [] };
			const only = ["build-surface-map"];
			runDoctorRepair({ root, selection });
			assert.equal(readFileSync(mapPath, "utf8"), originalMap);
			assert.equal(readFileSync(catalogPath, "utf8"), originalCatalog);
			const unconfirmed = runDoctorRepair({ root, selection, only });
			assert.ok(unconfirmed.findings.some((finding) => /confirm-surface-current/.test(finding.message)));
			assert.equal(readFileSync(mapPath, "utf8"), originalMap);
			assert.equal(readFileSync(catalogPath, "utf8"), originalCatalog);
			const confirmed = runDoctorRepair({ root, selection, only, confirmedSurfaces: [`sample:${surfaceMapDigest(map)}`] });
			assert.ok(!confirmed.findings.some((finding) => /confirm-surface-current/.test(finding.message)));
			for (const invalidMap of ["invalid json", JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ ...map, binaries: [null] }), JSON.stringify({ ...map, probes: [null] }), JSON.stringify({ ...map, commands: [null] })]) {
				writeFileSync(mapPath, invalidMap);
				writeFileSync(catalogPath, JSON.stringify({ experiences: [null] }));
				const invalid = runDoctorRepair({ root, selection, only });
				assert.equal(readFileSync(mapPath, "utf8"), invalidMap);
				assert.equal(readFileSync(catalogPath, "utf8"), JSON.stringify({ experiences: [null] }));
				assert.ok(invalid.findings.some((finding) => /invalid or unreadable/.test(finding.message) && !finding.repairable));
			}
			rmSync(mapPath);
			rmSync(catalogPath);
			rmSync(marker);
			const created = runDoctorRepair({ root, selection, only });
			assert.ok(created.repairsApplied.includes("build-surface-map:sample"));
			assert.equal(existsSync(marker), false);
			assert.equal(existsSync(mapPath), true);
			assert.equal(existsSync(catalogPath), false);
		});
	});

	it("uses the unscoped package name for a string-form bin", () => {
		fixture((root, dir) => {
			writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@scope/actual-name", bin: "bin/sample.mjs" }));
			const map = buildSurfaceMap({ project, root });
			assert.equal(map.binaries[0]?.name, "actual-name");
			assert.equal(map.defaultEntry?.command, "actual-name");
		});
	});

	it("rejects an old surface map after a previously observed command disappears", () => {
		fixture((root) => {
			mkdirSync(path.join(root, ".git"));
			const dir = path.join(root, "packages/hobo");
			mkdirSync(path.join(dir, "bin"), { recursive: true });
			const hobo = { id: "hobo", path: "packages/hobo", kind: "package" as const, label: "hobo" };
			writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "hobo", bin: { hobo: "bin/hobo.mjs" } }));
			const bin = path.join(dir, "bin/hobo.mjs");
			writeFileSync(bin, 'console.log("  up       Start app\\n  status   Inspect status");\n');
			const first = buildSurfaceMap({ project: hobo, root, probeBinary: true });
			const catalog = buildExperienceCatalog({ project: hobo, root, personaIds: ["herdr"], surfaceMap: first });
			assert.ok(catalog.experiences.some((entry) => entry.entryCommand === "hobo status"));
			writeSurfaceMap(first, hobo, root);
			const confirmation = `hobo:${surfaceMapDigest(first)}`;
			const selection = { allProjects: false, projects: [hobo], requested: ["hobo"], unknown: [] };
			assert.match(validateCatalogCoverage(catalog, ["herdr"], first, { root }).join("; "), /confirm-surface-current/);
			assert.match(validateCatalogCoverage(catalog, ["herdr"], first, { root, confirmedSurfaces: [`other:${surfaceMapDigest(first)}`] }).join("; "), /confirm-surface-current/);
			assert.deepEqual(validateCatalogCoverage(catalog, ["herdr"], first, { root, confirmedSurfaces: [confirmation] }), []);
			const unconfirmed = runDoctorCheck({ root, selection });
			assert.ok(unconfirmed.findings.some((finding) => finding.id === "surface-map-invalid" && /confirm-surface-current/.test(finding.message)));
			const explorer = fileURLToPath(new URL("../explore-app.mts", import.meta.url));
			const validate = () => spawnSync(process.execPath, [explorer, "--mode", "validate", "--project", "hobo", `--confirm-surface-current=${confirmation}`], { cwd: root, encoding: "utf8" });
			assert.equal(validate().status, 0);
			writeFileSync(bin, 'console.log("  up       Start app");\n');
			assert.match(validateCatalogCoverage(catalog, ["herdr"], first, { root, confirmedSurfaces: [confirmation] }).join("; "), /executable changed/);
			const changedExecutable = runDoctorCheck({ root, selection, confirmedSurfaces: [confirmation] });
			assert.ok(changedExecutable.findings.some((finding) => finding.id === "surface-map-invalid" && /executable changed/.test(finding.message)));
			const staleValidation = validate();
			assert.equal(staleValidation.status, 1);
			assert.match(staleValidation.stdout, /executable changed/);
			const changed = buildSurfaceMap({ project: hobo, root, probeBinary: true });
			writeSurfaceMap(changed, hobo, root);
			assert.match(validateCatalogCoverage(catalog, ["herdr"], changed, { root, freshProbe: true }).join("; "), /stale/);
		});
	});

	it("maps the FinOps goal only to cost-specific observed help", () => {
		fixture((root, dir) => {
			packageWithBin(dir);
			const personas = path.join(root, ".optimizexp/personas");
			mkdirSync(personas, { recursive: true });
			writeFileSync(path.join(personas, "role-finops.md"), '---\nid: role-finops\nexperiences: [dx]\ninterfaces: [cli]\n---\nInspect cost information.\n');
			const bin = path.join(dir, "bin/sample.mjs");
			writeFileSync(bin, 'console.log("  up       Start app");\n');
			const noPlan = buildSurfaceMap({ project, root, probeBinary: true });
			const unknown = buildExperienceCatalog({ project, root, personaIds: ["role-finops"], surfaceMap: noPlan });
			assert.ok(!unknown.experiences.some((entry) => entry.entryCommand === "sample plan"));
			assert.match(validateCatalogCoverage(unknown, ["role-finops"], noPlan, { root, freshProbe: true }).join("; "), /goal is unverified/);
			writeFileSync(bin, 'console.log("  up       Start app\\n  plan     Preview changes");\n');
			const genericPlan = buildSurfaceMap({ project, root, probeBinary: true });
			const genericCatalog = buildExperienceCatalog({ project, root, personaIds: ["role-finops"], surfaceMap: genericPlan });
			assert.ok(!genericCatalog.experiences.some((entry) => entry.entryCommand === "sample plan"));
			assert.match(validateCatalogCoverage(genericCatalog, ["role-finops"], genericPlan, { root, freshProbe: true }).join("; "), /goal is unverified/);
			writeFileSync(bin, 'console.log("  up       Start app\\n  plan     Does not report costs");\n');
			const negativePlan = buildSurfaceMap({ project, root, probeBinary: true });
			const negativeCatalog = buildExperienceCatalog({ project, root, personaIds: ["role-finops"], surfaceMap: negativePlan });
			assert.ok(!negativeCatalog.experiences.some((entry) => entry.entryCommand === "sample plan"));
			writeFileSync(bin, 'console.log("  up       Start app\\n  plan     Preview changes and estimate costs");\n');
			const plan = buildSurfaceMap({ project, root, probeBinary: true });
			const known = buildExperienceCatalog({ project, root, personaIds: ["role-finops"], surfaceMap: plan });
			const costJourney = known.experiences.find((entry) => entry.entryCommand === "sample plan" && /cost information/.test(entry.intent));
			assert.ok(costJourney);
			assert.match(costJourney.observableSuccess, /reports cost or budget information/);
			assert.match(costJourney.observableFailure, /missing or unavailable/);
			assert.deepEqual(validateCatalogCoverage(known, ["role-finops"], plan, { root, freshProbe: true }), []);
		});
	});
});
