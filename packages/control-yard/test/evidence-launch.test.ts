import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
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
	captureErrorsSchema,
	captureFailureMessages,
} from "../scripts/capture-failures.mts";
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
						data: new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255]),
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

it("reports a missing configured browser and closes its local servers", () => {
	const scratch = mkdtempSync(join(tmpdir(), "yard-launch-test-"));
	const missingBrowser = join(scratch, "missing-chromium");
	try {
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				resolve(import.meta.dirname, "../scripts/play-demo.mts"),
			],
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
			join(packageRoot, "scripts/capture-failures.mts"),
			join(scratch, "scripts/capture-failures.mts"),
		);
		cpSync(join(packageRoot, "public/shots"), shots, { recursive: true });
		const manifestPath = join(shots, "evidence-manifest.json");
		const reportPath = join(shots, "visual-report.json");
		const manifest: {
			errors?: string[];
			files: Record<string, { bytes: number; sha256: string }>;
		} = JSON.parse(readFileSync(manifestPath, "utf8"));
		const report: { errors?: string[] } = JSON.parse(
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
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 25_000);
