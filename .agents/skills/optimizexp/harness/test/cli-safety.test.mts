import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { resolveProjects } from "../lib/projects.mts";

const harness = fileURLToPath(new URL("..", import.meta.url));

function fixture(run: (root: string) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "hobo-cli-safety-"));
	mkdirSync(path.join(root, ".git"));
	mkdirSync(path.join(root, "site"));
	mkdirSync(path.join(root, "packages/hobo"), { recursive: true });
	writeFileSync(path.join(root, "packages/hobo/package.json"), JSON.stringify({ name: "@hobo/hobo", scripts: { start: "node server.js" } }));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function invoke(root: string, cli: string, args: string[], env: NodeJS.ProcessEnv = {}) {
	return spawnSync(process.execPath, ["--experimental-strip-types", path.join(harness, `${cli}.mts`), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
}

function snapshot(root: string): string[] {
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			const rel = path.relative(root, file);
			if (entry.isDirectory()) {
				files.push(`dir:${rel}`);
				visit(file);
			} else {
				files.push(`file:${rel}:${readFileSync(file).toString("base64")}`);
			}
		}
	};
	visit(root);
	return files.sort();
}

describe("project selection and write safety", () => {
	it("runs native environment and explicit capture commands in the selected project", () => {
		fixture((root) => {
			writeFileSync(path.join(root, "marker.txt"), "ROOT");
			writeFileSync(path.join(root, "packages/hobo/marker.txt"), "PROJECT");
			const feature = path.join(root, "packages/hobo/.optimizexp/features/example");
			mkdirSync(feature, { recursive: true });
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "native", generatedFromSeed: true }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: observed\n    Then output is visible\n");
			const dir = path.join(feature, "evidence/observed");
			const command = 'cat marker.txt > "$OUT_DIR/frame.png"';
			const run = (env: NodeJS.ProcessEnv, extra: string[], expected: string, cwd: string) => {
				const result = invoke(root, "capture-evidence", ["--mode=capture", "--project=hobo", "--feature=example", "--scenario=observed", ...extra], env);
				assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
				const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as { repro: { cwd: string }; exitCode: number };
				assert.equal(meta.repro.cwd, cwd);
				assert.equal(meta.exitCode, 0);
				assert.equal(readFileSync(path.join(dir, "primary.png"), "utf8"), expected);
			};
			run({ OPTIMIZEXP_NATIVE_CAPTURE: command, OPTIMIZEXP_COMPUTER_USE_CAPTURE: "" }, [], "PROJECT", "packages/hobo");
			run({ OPTIMIZEXP_NATIVE_CAPTURE: "", OPTIMIZEXP_COMPUTER_USE_CAPTURE: command }, [], "PROJECT", "packages/hobo");
			run({ OPTIMIZEXP_NATIVE_CAPTURE: 'printf wrong > "$OUT_DIR/frame.png"', OPTIMIZEXP_COMPUTER_USE_CAPTURE: "" }, [`--native-cmd=${command}`], "PROJECT", "packages/hobo");
			run({ OPTIMIZEXP_NATIVE_CAPTURE: command, OPTIMIZEXP_COMPUTER_USE_CAPTURE: "" }, ["--cwd=root"], "ROOT", ".");
		});
	});

	it("preserves the prior review when artifact or proposed review validation fails", () => {
		fixture((root) => {
			const feature = path.join(root, ".optimizexp/features/example");
			mkdirSync(feature, { recursive: true });
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "cli" }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: observed\n    Then output is visible\n");
			const common = ["--project=root", "--feature=example", "--scenario=observed"];
			const capture = invoke(root, "capture-evidence", ["--mode=capture", ...common, "--command=printf original"]);
			assert.equal(capture.status, 0, capture.stderr);
			const dir = path.join(feature, "evidence/observed");
			const primary = path.join(dir, "primary.txt");
			const reviewPath = path.join(dir, "review.json");
			const original = readFileSync(primary);
			const pending = readFileSync(reviewPath);
			const args = ["--mode=review", ...common, "--reviewer=qa", "--relevant=yes", "--complete=yes", "--notes=Reviewed the complete captured journey"];
			writeFileSync(primary, "changed after capture");
			const changed = invoke(root, "capture-evidence", args);
			assert.equal(changed.status, 1, changed.stderr);
			assert.match(String(changed.stdout), /primary_artifact_hash_mismatch/);
			assert.deepEqual(readFileSync(reviewPath), pending);
			writeFileSync(primary, original);
			const strictPending = invoke(root, "capture-evidence", ["--mode=validate", ...common.slice(0, 2), "--strict"]);
			assert.equal(strictPending.status, 1, strictPending.stderr);
			assert.match(String(strictPending.stdout), /evidence_review_not_accepted/);
			const accepted = invoke(root, "capture-evidence", args);
			assert.equal(accepted.status, 0, `${accepted.stderr}\n${accepted.stdout}`);
			const prior = readFileSync(reviewPath);
			const rejected = invoke(root, "capture-evidence", [...args, "--complete=no", "--notes=short"]);
			assert.equal(rejected.status, 1, rejected.stderr);
			assert.match(String(rejected.stdout), /evidence_review_notes_missing_or_too_short/);
			assert.deepEqual(readFileSync(reviewPath), prior);
			const strictAccepted = invoke(root, "capture-evidence", ["--mode=validate", ...common.slice(0, 2), "--strict"]);
			assert.equal(strictAccepted.status, 0, `${strictAccepted.stderr}\n${strictAccepted.stdout}`);
			const malformed = invoke(root, "capture-evidence", [...args, "--relevant=perhaps"]);
			assert.equal(malformed.status, 1, malformed.stderr);
			assert.match(String(malformed.stdout), /review_relevance_or_completeness_invalid/);
			assert.deepEqual(readFileSync(reviewPath), prior);
			for (const negative of ["--complete=no", "--relevant=no"]) {
				const reset = invoke(root, "capture-evidence", args);
				assert.equal(reset.status, 0, `${reset.stderr}\n${reset.stdout}`);
				const declined = invoke(root, "capture-evidence", [...args, negative]);
				assert.equal(declined.status, 1, declined.stderr);
				assert.equal((JSON.parse(readFileSync(reviewPath, "utf8")) as { status: string }).status, "rejected");
				const strictRejected = invoke(root, "capture-evidence", ["--mode=validate", ...common.slice(0, 2), "--strict"]);
				assert.equal(strictRejected.status, 1, strictRejected.stderr);
				assert.match(String(strictRejected.stdout), /evidence_review_not_accepted/);
			}
		});
	});

	it("marks truncated stdout and stderr as degraded and rejects them as complete proof", () => {
		fixture((root) => {
			const feature = path.join(root, ".optimizexp/features/example");
			mkdirSync(feature, { recursive: true });
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "cli" }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: observed\n    Then output is visible\n");
			writeFileSync(path.join(root, "noisy.cjs"), 'process.stdout.write("VISIBLE_STDOUT\\n"); process.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 64, 65)); process.stderr.write("VISIBLE_STDERR\\n"); process.stderr.write(Buffer.alloc(8 * 1024 * 1024 + 64, 66));');
			const common = ["--project=root", "--feature=example", "--scenario=observed"];
			const capture = invoke(root, "capture-evidence", ["--mode=capture", ...common, "--command=node noisy.cjs"]);
			assert.equal(capture.status, 0, `${capture.stderr}\n${capture.stdout}`);
			const dir = path.join(feature, "evidence/observed");
			const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as { degraded: boolean; notes: string[]; exitCode: number };
			assert.equal(meta.exitCode, 0);
			assert.equal(meta.degraded, true);
			assert.ok(meta.notes.includes("stdout truncated after 8388608 bytes"));
			assert.ok(meta.notes.includes("stderr truncated after 8388608 bytes"));
			const transcript = readFileSync(path.join(dir, "primary.txt"), "utf8");
			assert.match(transcript, /degraded: true/);
			assert.match(transcript, /stdout truncated after 8388608 bytes/);
			assert.match(transcript, /stderr truncated after 8388608 bytes/);
			assert.match(transcript, /VISIBLE_STDOUT/);
			assert.match(transcript, /VISIBLE_STDERR/);
			const pending = readFileSync(path.join(dir, "review.json"));
			const review = invoke(root, "capture-evidence", ["--mode=review", ...common, "--reviewer=qa", "--relevant=yes", "--complete=yes", "--notes=Reviewed the complete captured journey"]);
			assert.equal(review.status, 1, review.stderr);
			assert.match(String(review.stdout), /degraded_capture_not_acceptable_proof/);
			assert.deepEqual(readFileSync(path.join(dir, "review.json")), pending);
		});
	});

	it("replays absolute cast timestamps and safely embeds terminal text", () => {
		fixture((root) => {
			const feature = path.join(root, ".optimizexp/features/example");
			const bin = path.join(root, "bin");
			mkdirSync(feature, { recursive: true });
			mkdirSync(bin);
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "tui" }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: observed\n    Then output is visible\n");
			const castPath = path.join(root, "fixture.cast");
			const payload = "</script><script>benign-terminal-output</script>";
			writeFileSync(castPath, [JSON.stringify({ version: 2, width: 80, height: 24 }), ...["one", "two", "three", payload].map((value, index) => JSON.stringify([index + 1, "o", value]))].join("\n") + "\n");
			writeFileSync(path.join(bin, "asciinema"), '#!/bin/sh\nfor arg do last="$arg"; done\ncp "$HOBO_TEST_CAST" "$last"\n', { mode: 0o755 });
			const capture = invoke(root, "capture-evidence", ["--mode=capture", "--project=root", "--feature=example", "--scenario=observed", "--command=printf ignored"], { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOBO_TEST_CAST: castPath });
			assert.equal(capture.status, 0, `${capture.stderr}\n${capture.stdout}`);
			const html = readFileSync(path.join(feature, "evidence/observed/REPLAY.html"), "utf8");
			assert.equal((html.match(/<\/script>/gi) ?? []).length, 1);
			assert.doesNotMatch(html, /<\/script><script>benign-terminal-output/);
			const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
			assert.ok(script);
			const elements: Record<string, { textContent: string; onclick?: () => void }> = { "#screen": { textContent: "" }, "#play": { textContent: "" }, "#stop": { textContent: "" } };
			const scheduled: { id: number; at: number; callback: () => void }[] = [];
			let now = 0;
			let nextId = 0;
			runInNewContext(script, {
				document: { querySelector: (selector: string) => elements[selector] },
				setTimeout: (callback: () => void, delay: number) => { const id = ++nextId; scheduled.push({ id, at: now + delay, callback }); return id; },
				clearTimeout: (id: number) => { const index = scheduled.findIndex((item) => item.id === id); if (index >= 0) scheduled.splice(index, 1); },
			});
			elements["#play"]!.onclick!();
			assert.equal(elements["#screen"]!.textContent, "");
			for (const [index, expected] of ["one", "onetwo", "onetwothree", `onetwothree${payload}`].entries()) {
				const event = scheduled.shift();
				assert.ok(event);
				assert.equal(event.at, (index + 1) * 1000);
				now = event.at;
				event.callback();
				assert.equal(elements["#screen"]!.textContent, expected);
			}
			assert.equal(scheduled.length, 0);
		});
	});

	it("captures selected-project and root-provenance commands in their actual directories", () => {
		fixture((root) => {
			for (const [dir, output] of [[root, "ROOT"], [path.join(root, "packages/hobo"), "PROJECT"]]) {
				writeFileSync(path.join(dir!, "package.json"), JSON.stringify({ name: output, scripts: { inspect: `node -e "console.log('${output}')"` } }));
			}
			const feature = path.join(root, "packages/hobo/.optimizexp/features/example");
			mkdirSync(feature, { recursive: true });
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: observed\n    Then output is visible\n");
			const metadata = path.join(feature, "feature.json");
			const evidence = path.join(feature, "evidence/observed");
			const base = { id: "example", driver: "cli", surfaces: ["npm run stale", "npm run inspect"], generatedFromSeed: true, primaryCommand: "npm run inspect" };
			const run = (extra: string[], expected: string, cwd: string) => {
				const result = invoke(root, "capture-evidence", ["--mode=capture", "--project=hobo", "--feature=example", "--scenario=observed", ...extra]);
				assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
				const report = JSON.parse(readFileSync(path.join(evidence, "meta.json"), "utf8")) as { repro: { cwd: string }; exitCode: number; degraded: boolean };
				assert.equal(report.repro.cwd, cwd);
				assert.equal(report.exitCode, 0);
				assert.equal(report.degraded, false);
				assert.match(readFileSync(path.join(evidence, "primary.txt"), "utf8"), new RegExp(expected));
			};
			writeFileSync(metadata, JSON.stringify({ id: "example", driver: "cli" }));
			run(["--command=npm run inspect"], "PROJECT", "packages/hobo");
			run(["--command=npm run inspect", "--cwd=root"], "ROOT", ".");
			writeFileSync(metadata, JSON.stringify(base));
			run([], "ROOT", ".");
			run(["--cwd=project"], "PROJECT", "packages/hobo");
			writeFileSync(metadata, JSON.stringify({ ...base, catalogOrigin: { projectId: "hobo", entryCommand: "npm run inspect" } }));
			run([], "PROJECT", "packages/hobo");
			const before = snapshot(root);
			const invalid = invoke(root, "capture-evidence", ["--mode=capture", "--project=hobo", "--feature=example", "--scenario=observed", "--command=npm run inspect", "--cwd=elsewhere"]);
			assert.equal(invalid.status, 2, String(invalid.stderr));
			assert.deepEqual(snapshot(root), before);
			const wrongMode = invoke(root, "capture-evidence", ["--mode=validate", "--project=hobo", "--feature=example", "--cwd=root"]);
			assert.equal(wrongMode.status, 2, String(wrongMode.stderr));
			assert.deepEqual(snapshot(root), before);
		});
	});

	it("rejects orphan evidence during strict validation while retaining non-strict inspection", () => {
		fixture((root) => {
			const feature = path.join(root, ".optimizexp/features/example");
			const orphan = path.join(feature, "evidence/orphan");
			mkdirSync(orphan, { recursive: true });
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example" }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n");
			writeFileSync(path.join(orphan, "manifest.json"), JSON.stringify({ primaryPath: "missing.txt" }));
			const args = ["--mode=validate", "--project=root", "--feature=example"];
			const nonStrict = invoke(root, "capture-evidence", args);
			assert.equal(nonStrict.status, 0, nonStrict.stderr);
			const strict = invoke(root, "capture-evidence", [...args, "--strict"]);
			assert.equal(strict.status, 1, strict.stderr);
			assert.match(String(strict.stdout), /evidence does not match a declared scenario/);
			writeFileSync(path.join(orphan, "missing.txt"), "unreviewed\n");
			writeFileSync(path.join(orphan, "review.json"), JSON.stringify({ status: "pending" }));
			const pending = invoke(root, "capture-evidence", [...args, "--strict"]);
			assert.equal(pending.status, 1, pending.stderr);
			assert.match(String(pending.stdout), /evidence does not match a declared scenario/);
		});
	});
	it("accepts exact known scenario titles containing punctuation without accepting paths", () => {
		fixture((root) => {
			const feature = path.join(root, ".optimizexp/features/example");
			mkdirSync(feature, { recursive: true });
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "cli" }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: CLI / web parity...\n    Then output is visible\n  Scenario: Ready... go\n    Then output is visible\n");
			for (const [title, slug] of [["CLI / web parity...", "cli-web-parity"], ["Ready... go", "ready-go"]]) {
				const common = ["--project=root", "--feature=example", `--scenario=${title}`];
				const capture = invoke(root, "capture-evidence", ["--mode=capture", ...common, "--command=printf done"]);
				assert.equal(capture.status, 0, capture.stderr);
				assert.ok(existsSync(path.join(feature, "evidence", slug!, "manifest.json")));
				const review = invoke(root, "capture-evidence", ["--mode=review", ...common, "--reviewer=test", "--relevant=yes", "--complete=yes", "--notes=Captured output demonstrates the complete scenario"]);
				assert.equal(review.status, 0, review.stderr);
				const stitch = invoke(root, "capture-evidence", ["--mode=stitch", ...common]);
				assert.equal(stitch.status, 1, stitch.stderr);
				assert.match(String(stitch.stderr), /no frames/);
			}
			const before = snapshot(root);
			for (const invalid of ["../../outside", "/outside", "..\\outside", "other / unlisted"]) {
				const result = invoke(root, "capture-evidence", ["--mode=capture", "--project=root", "--feature=example", `--scenario=${invalid}`, "--command=printf done"]);
				assert.equal(result.status, 2, result.stderr);
				assert.deepEqual(snapshot(root), before);
			}
		});
	});

	it("fails an explicitly requested missing feature while allowing an empty all-feature validation", () => {
		fixture((root) => {
			const before = snapshot(root);
			const missing = invoke(root, "capture-evidence", ["--mode=validate", "--strict", "--project=root", "--feature=absent"]);
			assert.equal(missing.status, 1, missing.stderr);
			assert.match(String(missing.stdout), /feature not found: absent/);
			const all = invoke(root, "capture-evidence", ["--mode=validate", "--strict", "--project=root"]);
			assert.equal(all.status, 0, all.stderr);
			assert.equal(JSON.parse(String(all.stdout)).features, 0);
			assert.deepEqual(snapshot(root), before);
		});
	});
	it("refuses unknown, mixed, malformed, missing, and misspelled selectors before every mutating entrypoint", () => {
		fixture((root) => {
			const cases: [string, string[]][] = [
				["explore-app", ["--mode=explore"]],
				["capture-evidence", ["--mode=init-feature", "--id=sample"]],
				["doctor", ["repair", "--only=ensure-config"]],
				["doctor", ["snapshot"]],
				["init", ["--mode=ensure-config"]],
			];
			const selectors = [
				["--project", "code"], ["--project=code"], ["--project=site,code"],
				["--project=all,code"], ["--project=../../site"], ["--project=/site"],
				["--all-projects", "--project=code"], ["--project"], ["--project="], ["--projec=site"],
			];
			const before = snapshot(root);
			for (const [cli, args] of cases) {
				for (const selector of selectors) {
					const result = invoke(root, cli, [...args, ...selector]);
					assert.equal(result.status, 2, `${cli} ${selector.join(" ")}: ${result.stderr}`);
					assert.deepEqual(snapshot(root), before, `${cli} ${selector.join(" ")} wrote files`);
				}
			}
		});
	});

	it("recognizes equals-form modes and refuses unknown modes without writes", () => {
		fixture((root) => {
			const before = snapshot(root);
			const explore = invoke(root, "explore-app", ["--mode=validate", "--project=site"]);
			assert.equal(explore.status, 1, explore.stderr);
			assert.deepEqual(snapshot(root), before);
			for (const cli of ["capture-evidence", "doctor", "init"]) {
				const result = invoke(root, cli, ["--mode=unexpected", "--project=site"]);
				assert.equal(result.status, 2, `${cli}: ${result.stderr}`);
				assert.deepEqual(snapshot(root), before);
			}
			for (const cli of ["explore-app", "generate-feature", "generate-persona"]) {
				const result = invoke(root, cli, ["--mode=unexpected", "--project=site"]);
				assert.notEqual(result.status, 0, `${cli}: ${result.stderr}`);
				assert.deepEqual(snapshot(root), before);
			}
		});
	});

	it("rejects unsupported positionals before writes while retaining mode and seed positionals", () => {
		fixture((root) => {
			const before = snapshot(root);
			const invalid: [string, string[]][] = [
				["explore-app", ["code"]],
				["doctor", ["repair", "code", "--only", "ensure-config"]],
				["doctor", ["--mode=repair", "check", "--only=ensure-config"]],
				["init", ["ensure-config", "code"]],
				["capture-evidence", ["init-feature", "code", "--id=sample"]],
				["capture-evidence", ["--mode=init-feature", "validate", "--id=sample"]],
			];
			for (const [cli, args] of invalid) {
				const result = invoke(root, cli, args);
				assert.equal(result.status, 2, `${cli} ${args.join(" ")}: ${result.stderr}`);
				assert.deepEqual(snapshot(root), before, `${cli} ${args.join(" ")} wrote files`);
			}
			const doctor = invoke(root, "doctor", ["check", "--project=root", "--json"]);
			assert.equal(doctor.status, 1, doctor.stderr);
			assert.match(doctor.stdout, /"mode": "check"/);
			const init = invoke(root, "init", ["list-projects"]);
			assert.equal(init.status, 0, init.stderr);
			const capture = invoke(root, "capture-evidence", ["validate"]);
			assert.equal(capture.status, 0, capture.stderr);
			assert.deepEqual(snapshot(root), before);
		});
	});

	it("retains valid all, root, scoped-package and existing-project selection", () => {
		fixture((root) => {
			assert.equal(resolveProjects("all", root).allProjects, true);
			assert.deepEqual(resolveProjects("root", root).projects.map((project) => project.id), ["root"]);
			assert.deepEqual(resolveProjects("@hobo/hobo", root).projects.map((project) => project.id), ["hobo"]);
			assert.deepEqual(resolveProjects("packages/hobo", root).projects.map((project) => project.id), ["hobo"]);
			assert.deepEqual(resolveProjects("site,hobo", root).unknown, []);
			assert.ok(resolveProjects("../../site", root).unknown.length);
			const allCapture = invoke(root, "capture-evidence", ["--mode=validate", "--all-projects"]);
			assert.equal(allCapture.status, 0, allCapture.stderr);
			const allExplore = invoke(root, "explore-app", ["--mode=validate", "--all-projects"]);
			assert.equal(allExplore.status, 1, allExplore.stderr);
			assert.equal(existsSync(path.join(root, ".optimizexp")), false);
			const noConfig = invoke(root, "init", ["--mode=ensure-config", "--project=root", "--dry-run"]);
			assert.equal(noConfig.status, 2, noConfig.stderr);
			assert.equal(existsSync(path.join(root, ".optimizexp")), false);
		});
	});

	it("preserves every existing evidence artifact for invalid selectors and capture inputs", () => {
		fixture((root) => {
			const feature = path.join(root, ".optimizexp/features/example");
			const evidence = path.join(feature, "evidence/observed");
			mkdirSync(evidence, { recursive: true });
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "cli", surfaces: [] }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: observed\n    Then evidence exists\n");
			for (const name of ["primary.txt", "manifest.json", "meta.json", "review.json", "REPLAY.md", "_handoff.sh"]) {
				writeFileSync(path.join(evidence, name), `preserve ${name}\n`);
			}
			const before = snapshot(root);
			const invalid = [
				["--project=code"], ["--project=root", "--driver=cli"],
				["--project=root", "--driver=tui"], ["--project=root", "--driver=web", "--url=not-a-url"],
				["--project=root", "--driver=unknown"], ["--project=root", "--scenario=../../outside", "--command=printf safe"],
			];
			for (const args of invalid) {
				const result = invoke(root, "capture-evidence", ["--mode=capture", "--feature=example", "--scenario=observed", ...args]);
				assert.equal(result.status, 2, result.stderr);
				assert.deepEqual(snapshot(root), before, `capture ${args.join(" ")} changed evidence`);
			}
		});
	});

	it("rejects path-like feature identifiers before creating or replacing files", () => {
		fixture((root) => {
			const before = snapshot(root);
			for (const id of ["../../escape", "/tmp/escape", "nested/feature", "nested\\feature"]) {
				const capture = invoke(root, "capture-evidence", ["--mode=init-feature", "--project=root", `--id=${id}`]);
				assert.equal(capture.status, 2, capture.stderr);
				assert.deepEqual(snapshot(root), before);
			}
		});
	});

	it("captures only the selected project's same-named feature and claims", () => {
		fixture((root) => {
			for (const projectPath of ["site", "packages/hobo"]) {
				const feature = path.join(root, projectPath, ".optimizexp/features/example");
				const evidence = path.join(feature, "evidence/observed");
				mkdirSync(evidence, { recursive: true });
				writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "cli", surfaces: [] }));
				writeFileSync(path.join(feature, "example.feature"), `Feature: Example\n  Scenario: observed\n    Then ${projectPath} is visible\n`);
				writeFileSync(path.join(evidence, "primary.txt"), `original ${projectPath}\n`);
			}
			const other = path.join(root, "packages/hobo/.optimizexp/features/example/evidence/observed/primary.txt");
			const before = readFileSync(other);
			const result = invoke(root, "capture-evidence", ["--mode=capture", "--project=site", "--feature=example", "--scenario=observed", "--command=printf site"]);
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(readFileSync(other), before);
			const meta = readFileSync(path.join(root, "site/.optimizexp/features/example/evidence/observed/meta.json"), "utf8");
			assert.match(meta, /Then site is visible/);
			assert.doesNotMatch(meta, /Then packages\/hobo is visible/);
		});
	});
});
