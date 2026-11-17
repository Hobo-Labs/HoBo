import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import {
	captureChecksSchema,
	captureErrorsSchema,
	captureFailureMessages,
} from "../scripts/capture-failures.mts";
import { validateEvidence } from "../scripts/evidence-validator.mts";
import { compareImages } from "../scripts/image-diff.mts";
import { sampleBoInk } from "../scripts/sample-bo-ink.mts";

it("accepts historical omissions but refuses recorded or malformed failures", () => {
	expect(
		captureFailureMessages(
			captureErrorsSchema.safeParse(undefined),
			captureErrorsSchema.safeParse(undefined),
		),
	).toEqual([]);
	expect(
		captureFailureMessages(
			captureErrorsSchema.safeParse([]),
			captureErrorsSchema.safeParse([]),
		),
	).toEqual([]);
	expect(
		captureFailureMessages(
			captureErrorsSchema.safeParse(undefined),
			captureErrorsSchema.safeParse(["failed"]),
		),
	).toEqual(["capture reported failure: failed"]);
	expect(
		captureFailureMessages(
			captureErrorsSchema.safeParse("failed"),
			captureErrorsSchema.safeParse(undefined),
		),
	).toEqual(["evidence-manifest.json has an invalid capture errors list"]);
});

it("samples the canvas after serialization into the browser's realm", () => {
	const sample = runInNewContext(`(${sampleBoInk.toString()})()`, {
		document: {
			querySelector: () => ({
				getContext: () => ({
					getImageData: () => ({
						data: new Uint8ClampedArray([
							10, 10, 10, 255, 200, 200, 200, 255, 0, 0, 0, 0, 0, 0, 0, 127,
						]),
					}),
				}),
			}),
		},
		window: {
			__TEST__: {
				sceneKey: "Yard",
				state: () => ({ bo: { x: 40, y: 100 } }),
			},
		},
	});
	expect(sample).toMatchObject({ dark: 1, bo: { x: 40, y: 100 } });
});

it("requires a real image comparison and a reviewed baseline", () => {
	const scratch = mkdtempSync(join(tmpdir(), "yard-imgdiff-test-"));
	try {
		const baseline = join(scratch, "baseline.png");
		const current = join(scratch, "current.png");
		writeFileSync(current, "current image");
		let calls = 0;
		const missingPillow = () => {
			calls++;
			return {
				status: 2,
				stdout: "",
				stderr: "ModuleNotFoundError: No module named 'PIL'",
			};
		};
		expect(
			compareImages(baseline, current, "out.png", missingPillow),
		).toMatchObject({ ok: false });
		expect(calls).toBe(0);
		expect(existsSync(baseline)).toBe(false);
		writeFileSync(baseline, "reviewed image");
		expect(
			compareImages(baseline, current, "out.png", missingPillow),
		).toMatchObject({
			ok: false,
			detail: expect.stringContaining("dependency unavailable"),
		});
		expect(readFileSync(baseline, "utf8")).toBe("reviewed image");
		expect(
			compareImages(baseline, current, "out.png", () => ({
				status: 1,
				stdout: "Images differ (RMS=18.0, threshold=12.0).",
				stderr: "",
			})),
		).toMatchObject({
			ok: true,
			detail: expect.stringContaining("accepted image drift"),
		});
		expect(readFileSync(baseline, "utf8")).toBe("reviewed image");
		expect(
			compareImages(baseline, current, "out.png", () => ({
				status: 1,
				stdout: "Images differ (RMS=26.0, threshold=12.0).",
				stderr: "",
			})),
		).toMatchObject({ ok: false });
		expect(
			compareImages(baseline, current, "out.png", () => ({
				status: 2,
				stdout: "RMS=1.0",
				stderr: "comparison failed",
			})),
		).toMatchObject({ ok: false });
		expect(readFileSync(baseline, "utf8")).toBe("reviewed image");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

it("invalidates both old evidence copies when browser launch fails", () => {
	const packageRoot = resolve(import.meta.dirname, "..");
	const tempRoot = join(packageRoot, "tmp");
	mkdirSync(tempRoot, { recursive: true });
	const scratch = mkdtempSync(join(tempRoot, "yard-launch-test-"));
	const fixturePackage = join(scratch, "packages/control-yard");
	const fixtureScripts = join(fixturePackage, "scripts");
	const shots = join(fixturePackage, "public/shots");
	const proof = join(
		scratch,
		"src/draft/exp-proofs/ux/control-yard/assets/evidence",
	);
	const missingBrowser = join(scratch, "missing-chromium");
	try {
		mkdirSync(fixtureScripts, { recursive: true });
		for (const script of [
			"play-demo.mts",
			"capture-tour.mts",
			"image-diff.mts",
			"sample-bo-ink.mts",
			"evidence-check.mts",
			"evidence-validator.mts",
			"capture-failures.mts",
		]) {
			cpSync(
				join(packageRoot, "scripts", script),
				join(fixtureScripts, script),
			);
		}
		cpSync(join(packageRoot, "public/shots"), shots, { recursive: true });
		cpSync(shots, proof, { recursive: true });
		const originalImage = readFileSync(join(shots, "01-boot-live.png"));
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", join(fixtureScripts, "play-demo.mts")],
			{
				encoding: "utf8",
				timeout: 20_000,
				env: {
					...process.env,
					CHROME_PATH: missingBrowser,
					TEMP: scratch,
					TMP: scratch,
					TMPDIR: scratch,
				},
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(missingBrowser);
		expect(result.stderr).toContain("executable doesn't exist");
		expect(readFileSync(join(shots, "01-boot-live.png"))).toEqual(
			originalImage,
		);
		for (const dir of [shots, proof]) {
			expect(existsSync(join(dir, ".capture-incomplete"))).toBe(true);
			const check = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					join(fixtureScripts, "evidence-check.mts"),
					dir,
				],
				{
					encoding: "utf8",
					timeout: 20_000,
				},
			);
			expect(check.status).not.toBe(0);
			expect(check.stderr).toContain("capture incomplete");
		}
		expect(existsSync(join(shots, ".capture-lock"))).toBe(false);
		for (const dir of [shots, proof]) rmSync(join(dir, ".capture-incomplete"));
		mkdirSync(join(shots, ".capture-lock"));
		for (const dir of [shots, proof]) {
			const checking = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					join(fixtureScripts, "evidence-check.mts"),
					dir,
				],
				{ encoding: "utf8", timeout: 20_000 },
			);
			expect(checking.status).not.toBe(0);
			expect(checking.stderr).toContain("capture in progress or interrupted");
		}
		const locked = spawnSync(
			process.execPath,
			["--experimental-strip-types", join(fixtureScripts, "play-demo.mts")],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(locked.status).not.toBe(0);
		expect(locked.stderr).toContain(join(shots, ".capture-lock"));
		expect(locked.stderr).toContain(
			"ensure no capture is running and remove a stale lock",
		);
		expect(
			readdirSync(scratch).filter((name) => name.startsWith("hobo-yard-play-")),
		).toEqual([]);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 25_000);

it("refuses failures in the manifest or its report even when files match", () => {
	const packageRoot = resolve(import.meta.dirname, "..");
	const tempRoot = join(packageRoot, "tmp");
	mkdirSync(tempRoot, { recursive: true });
	const scratch = mkdtempSync(join(tempRoot, "yard-evidence-check-test-"));
	const script = join(scratch, "scripts/evidence-check.mts");
	const shots = join(scratch, "public/shots");
	try {
		mkdirSync(join(scratch, "scripts"), { recursive: true });
		cpSync(join(packageRoot, "scripts/evidence-check.mts"), script);
		cpSync(
			join(packageRoot, "scripts/evidence-validator.mts"),
			join(scratch, "scripts/evidence-validator.mts"),
		);
		cpSync(
			join(packageRoot, "scripts/capture-failures.mts"),
			join(scratch, "scripts/capture-failures.mts"),
		);
		cpSync(join(packageRoot, "public/shots"), shots, { recursive: true });
		const manifestPath = join(shots, "evidence-manifest.json");
		const reportPath = join(shots, "visual-report.json");
		const manifest: {
			errors?: string[];
			checks?: string[];
			files: Record<string, { bytes: number; sha256: string }>;
		} = JSON.parse(readFileSync(manifestPath, "utf8"));
		const report: { errors?: string[]; checks?: string[] } = JSON.parse(
			readFileSync(reportPath, "utf8"),
		);
		const runCheck = () =>
			spawnSync(process.execPath, ["--experimental-strip-types", script], {
				cwd: packageRoot,
				encoding: "utf8",
				timeout: 20_000,
			});
		const saveReport = () => {
			const contents = Buffer.from(JSON.stringify(report));
			writeFileSync(reportPath, contents);
			manifest.files["visual-report.json"] = {
				bytes: contents.length,
				sha256: createHash("sha256").update(contents).digest("hex"),
			};
			writeFileSync(manifestPath, JSON.stringify(manifest));
		};
		const probeCalls: string[] = [];
		const testProbe = (path: string) => {
			probeCalls.push(path);
			return { status: 0, stdout: "2.5\n", stderr: "" };
		};
		const validateWithTestProbe = () =>
			validateEvidence(shots, join(shots, ".capture-lock"), testProbe);

		manifest.errors = ["imgdiff boot failed"];
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const result = runCheck();
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"capture reported failure: imgdiff boot failed",
		);

		delete manifest.errors;
		report.errors = ["imgdiff bay failed"];
		saveReport();
		const reportFailure = runCheck();
		expect(reportFailure.error).toBeUndefined();
		expect(reportFailure.status).not.toBe(0);
		expect(reportFailure.stderr).toContain(
			"capture reported failure: imgdiff bay failed",
		);

		delete report.errors;
		delete manifest.checks;
		delete report.checks;
		saveReport();
		expect(validateWithTestProbe()).toBe(0);
		expect(probeCalls).toHaveLength(4);
		const emptyPath = join(scratch, "no-ffprobe");
		mkdirSync(emptyPath);
		const noFfprobe = spawnSync(
			process.execPath,
			["--experimental-strip-types", script],
			{
				cwd: packageRoot,
				encoding: "utf8",
				timeout: 20_000,
				env: { ...process.env, PATH: emptyPath },
			},
		);
		expect(noFfprobe.status).not.toBe(0);
		expect(noFfprobe.stderr).toContain("ffprobe failed for recordings/");

		manifest.checks = ["FAIL canvas ink — transparent"];
		saveReport();
		const failedManifestCheck = runCheck();
		expect(failedManifestCheck.status).not.toBe(0);
		expect(failedManifestCheck.stderr).toContain(
			"capture recorded failed check: FAIL canvas ink",
		);

		delete manifest.checks;
		report.checks = ["FAIL imgdiff boot — unavailable"];
		saveReport();
		const failedReportCheck = runCheck();
		expect(failedReportCheck.status).not.toBe(0);
		expect(failedReportCheck.stderr).toContain(
			"capture recorded failed check: FAIL imgdiff boot",
		);

		delete report.checks;
		saveReport();
		rmSync(join(shots, "06-after-actions.png"));
		const missing = runCheck();
		expect(missing.status).not.toBe(0);
		expect(missing.stderr).toContain(
			"missing manifested evidence: 06-after-actions.png",
		);
		cpSync(
			join(packageRoot, "public/shots/06-after-actions.png"),
			join(shots, "06-after-actions.png"),
		);
		const extra = Buffer.from("an additional recorded artifact");
		writeFileSync(join(shots, "extra.txt"), extra);
		manifest.files["extra.txt"] = {
			bytes: extra.length,
			sha256: createHash("sha256").update(extra).digest("hex"),
		};
		saveReport();
		expect(validateWithTestProbe()).toBe(0);
		rmSync(join(shots, "extra.txt"));
		const missingExtra = runCheck();
		expect(missingExtra.status).not.toBe(0);
		expect(missingExtra.stderr).toContain(
			"missing manifested evidence: extra.txt",
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 25_000);

it("rejects malformed checks and old image-comparison skips", () => {
	const noErrors = captureErrorsSchema.safeParse(undefined);
	const noChecks = captureChecksSchema.safeParse(undefined);
	expect(
		captureFailureMessages(
			noErrors,
			noErrors,
			captureChecksSchema.safeParse("FAIL"),
			noChecks,
		),
	).toContain("evidence-manifest.json has an invalid capture checks list");
	expect(
		captureFailureMessages(
			noErrors,
			noErrors,
			noChecks,
			captureChecksSchema.safeParse([
				"PASS imgdiff boot — imgdiff skipped (deps): no Pillow",
			]),
		),
	).toContain(
		"capture did not compare images: PASS imgdiff boot — imgdiff skipped (deps): no Pillow",
	);
});
