import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { runInNewContext } from "node:vm";
import {
	connectionCreate,
	createManagementContext,
	projectYardSnapshot,
	stationInit,
	stationUp,
} from "@hobo/management";
import { expect, it } from "vitest";
import {
	captureChecksSchema,
	captureErrorsSchema,
	captureFailureMessages,
} from "../scripts/capture-failures.mts";
import { validateEvidence } from "../scripts/evidence-validator.mts";
import { compareImages } from "../scripts/image-diff.mts";
import { sampleBoInk } from "../scripts/sample-bo-ink.mts";
import {
	confirmSheet,
	sheetForConnectionCreate,
} from "../src/openui/sheets.js";

it("creates a connection from the blank default beside an existing work alias", () => {
	const home = mkdtempSync(join(tmpdir(), "yard-connection-default-"));
	try {
		const ctx = createManagementContext({ hoboHome: home });
		stationInit(ctx, { name: "local", tenant: "local" });
		stationUp(ctx, "station:local");
		expect(
			connectionCreate(ctx, {
				provider: "asana",
				alias: "work",
				stationId: "station:local",
			}).ok,
		).toBe(true);
		const snapshot = projectYardSnapshot(ctx, { stationId: "station:local" });
		if (!snapshot.ok || !snapshot.data) throw new Error(snapshot.message);
		const sheet = sheetForConnectionCreate(snapshot.data);
		expect(sheet.fields.find((field) => field.name === "alias")?.value).toBe(
			"",
		);
		const unexpected = () => {
			throw new Error("unexpected sheet handler");
		};
		const created = confirmSheet(
			sheet,
			{ provider: "asana", alias: "", stationId: "station:local" },
			{
				connectionCreate: (input) => connectionCreate(ctx, input),
				connectionAuthorize: unexpected,
				stationRailsActivate: unexpected,
				stationRailsApprove: unexpected,
				stationRailsPublish: unexpected,
				doctorSnapshot: unexpected,
			},
		);
		expect(created.ok).toBe(true);
		const after = projectYardSnapshot(ctx, { stationId: "station:local" });
		if (!after.ok || !after.data) throw new Error(after.message);
		expect(after.data.connections).toHaveLength(2);
		expect(
			after.data.connections.some(
				(connection) => connection.alias === undefined,
			),
		).toBe(true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

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

type CaptureFixture = { shots: string; proof: string; outside: string };

function writerFixture() {
	const scratch = mkdtempSync(join(tmpdir(), "yard-writer-preflight-"));
	const packageRoot = resolve(import.meta.dirname, "..");
	const scripts = join(scratch, "packages/control-yard/scripts");
	const shots = join(scratch, "packages/control-yard/public/shots");
	const proof = join(
		scratch,
		"src/draft/exp-proofs/ux/control-yard/assets/evidence",
	);
	const outside = join(scratch, "outside");
	mkdirSync(scripts, { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(outside, "sentinel"), "outside bytes must survive\n");
	for (const script of ["play-demo.mts", "capture-preflight.mts"]) {
		cpSync(join(packageRoot, "scripts", script), join(scripts, script));
	}
	for (const dir of [shots, proof]) {
		mkdirSync(join(dir, "recordings"), { recursive: true });
		writeFileSync(join(dir, ".capture-incomplete"), "old marker\n");
		writeFileSync(join(dir, "evidence-manifest.json"), "old manifest\n");
		writeFileSync(join(dir, "01-boot-live.diff.png"), "old diff 1\n");
		writeFileSync(
			join(dir, "02-connection-bay-sheet.diff.png"),
			"old diff 2\n",
		);
		writeFileSync(join(dir, "recordings/tour.mp4"), "old video\n");
	}
	writeFileSync(
		join(scripts, "capture-tour.mts"),
		`
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const checkout = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const shots = join(checkout, "packages/control-yard/public/shots");
const proof = join(checkout, "src/draft/exp-proofs/ux/control-yard/assets/evidence");
if (![shots, proof].every((d) => existsSync(join(d, ".capture-incomplete")))) throw new Error("missing markers");
for (const dir of [shots, proof]) {
  writeFileSync(join(dir, "evidence-manifest.json"), "new manifest\\n");
  writeFileSync(join(dir, "01-boot-live.diff.png"), "new diff\\n");
}
writeFileSync(join(checkout, "stub-ran"), "captured\\n");
`,
	);
	return { scratch, scripts, shots, proof, outside };
}

function snapshotTree(root: string): string[] {
	const entries: string[] = [];
	const visit = (path: string, name: string) => {
		const info = lstatSync(path);
		if (info.isSymbolicLink()) {
			entries.push(`${name}:link:${readlinkSync(path)}`);
		} else if (info.isDirectory()) {
			entries.push(`${name}:dir:${info.mode}`);
			for (const child of readdirSync(path).sort()) {
				visit(join(path, child), `${name}/${child}`);
			}
		} else {
			entries.push(
				`${name}:file:${info.mode}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
			);
		}
	};
	visit(root, ".");
	return entries;
}

const replaceWithLink = (path: string, target: string) => {
	rmSync(path);
	symlinkSync(target, path);
};
const moveAndLink = (path: string, target: string) => {
	renameSync(path, target);
	symlinkSync(target, path, "dir");
};

const unsafeWriters: Array<[string, (fixture: CaptureFixture) => void]> = [
	[
		"shots root",
		({ shots, outside }) => moveAndLink(shots, join(outside, "shots")),
	],
	[
		"shots ancestor",
		({ shots, outside }) =>
			moveAndLink(dirname(shots), join(outside, "public")),
	],
	[
		"proof root",
		({ proof, outside }) => moveAndLink(proof, join(outside, "evidence")),
	],
	[
		"proof ancestor",
		({ proof, outside }) =>
			moveAndLink(dirname(proof), join(outside, "assets")),
	],
	...(["shots", "proof"] as const).flatMap(
		(key): Array<[string, (fixture: CaptureFixture) => void]> =>
			[".capture-incomplete", "evidence-manifest.json"].map((file) => [
				`${key} ${file}`,
				(fixture) =>
					replaceWithLink(
						join(fixture[key], file),
						join(fixture.outside, "sentinel"),
					),
			]),
	),
	...["01-boot-live.diff.png", "02-connection-bay-sheet.diff.png"].map(
		(file): [string, (fixture: CaptureFixture) => void] => [
			file,
			({ shots, outside }) =>
				replaceWithLink(join(shots, file), join(outside, "sentinel")),
		],
	),
	[
		"recordings parent",
		({ shots, outside }) =>
			moveAndLink(join(shots, "recordings"), join(outside, "recordings")),
	],
	[
		"recording leaf",
		({ shots, outside }) =>
			replaceWithLink(
				join(shots, "recordings/tour.mp4"),
				join(outside, "sentinel"),
			),
	],
	[
		"dangling symlink",
		({ shots, outside }) =>
			replaceWithLink(
				join(shots, "01-boot-live.diff.png"),
				join(outside, "missing"),
			),
	],
	[
		"hardlinked manifest",
		({ shots, outside }) => {
			const path = join(shots, "evidence-manifest.json");
			rmSync(path);
			linkSync(join(outside, "sentinel"), path);
		},
	],
];

it.each(
	unsafeWriters,
)("refuses unsafe %s before modifying either tree", (_name, arrange) => {
	const fixture = writerFixture();
	try {
		arrange(fixture);
		const before = snapshotTree(fixture.scratch);
		const capture = spawnSync(
			process.execPath,
			["--experimental-strip-types", join(fixture.scripts, "play-demo.mts")],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(capture.error).toBeUndefined();
		expect(capture.status).not.toBe(0);
		expect(capture.stderr).toContain("Unsafe capture destination");
		expect(snapshotTree(fixture.scratch)).toEqual(before);
	} finally {
		rmSync(fixture.scratch, { recursive: true, force: true });
	}
});

it("captures normally after preflight on two ordinary evidence trees", () => {
	const fixture = writerFixture();
	try {
		const capture = spawnSync(
			process.execPath,
			["--experimental-strip-types", join(fixture.scripts, "play-demo.mts")],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(capture.error).toBeUndefined();
		expect(capture.stderr).toBe("");
		expect(capture.status).toBe(0);
		expect(readFileSync(join(fixture.scratch, "stub-ran"), "utf8")).toBe(
			"captured\n",
		);
		for (const dir of [fixture.shots, fixture.proof]) {
			expect(readFileSync(join(dir, "evidence-manifest.json"), "utf8")).toBe(
				"new manifest\n",
			);
			expect(existsSync(join(dir, ".capture-incomplete"))).toBe(false);
		}
		expect(existsSync(join(fixture.shots, ".capture-lock"))).toBe(false);
	} finally {
		rmSync(fixture.scratch, { recursive: true, force: true });
	}
});

it("retains the shared lock if proof marker cleanup fails", () => {
	const packageRoot = resolve(import.meta.dirname, "..");
	const tempRoot = join(packageRoot, "tmp");
	mkdirSync(tempRoot, { recursive: true });
	const scratch = mkdtempSync(join(tempRoot, "yard-marker-cleanup-test-"));
	const fixturePackage = join(scratch, "packages/control-yard");
	const scripts = join(fixturePackage, "scripts");
	const shots = join(fixturePackage, "public/shots");
	const proof = join(
		scratch,
		"src/draft/exp-proofs/ux/control-yard/assets/evidence",
	);
	try {
		mkdirSync(scripts, { recursive: true });
		for (const script of [
			"play-demo.mts",
			"capture-preflight.mts",
			"evidence-check.mts",
			"evidence-validator.mts",
			"capture-failures.mts",
		]) {
			cpSync(join(packageRoot, "scripts", script), join(scripts, script));
		}
		cpSync(join(packageRoot, "public/shots"), shots, { recursive: true });
		cpSync(shots, proof, { recursive: true });
		writeFileSync(
			join(scripts, "capture-tour.mts"),
			`
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const marker = join(root, "../../src/draft/exp-proofs/ux/control-yard/assets/evidence/.capture-incomplete");
rmSync(marker);
mkdirSync(marker);
writeFileSync(join(marker, "blocked"), "cannot remove this marker");
`,
		);
		const capture = spawnSync(
			process.execPath,
			["--experimental-strip-types", join(scripts, "play-demo.mts")],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(capture.status).not.toBe(0);
		expect(existsSync(join(shots, ".capture-incomplete"))).toBe(false);
		expect(existsSync(join(shots, ".capture-lock"))).toBe(true);
		for (const dir of [shots, proof]) {
			const check = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					join(scripts, "evidence-check.mts"),
					dir,
				],
				{ encoding: "utf8", timeout: 20_000 },
			);
			expect(check.status).not.toBe(0);
			expect(check.stderr).toContain("capture in progress or interrupted");
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 25_000);

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
			"capture-preflight.mts",
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
		mkdirSync(join(proof, ".capture-incomplete"));
		const partialSetup = spawnSync(
			process.execPath,
			["--experimental-strip-types", join(fixtureScripts, "play-demo.mts")],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(partialSetup.status).not.toBe(0);
		expect(existsSync(join(shots, ".capture-incomplete"))).toBe(true);
		expect(existsSync(join(shots, ".capture-lock"))).toBe(true);
		rmSync(join(proof, ".capture-incomplete"), { recursive: true });
		const proofAfterFailure = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				join(fixtureScripts, "evidence-check.mts"),
				proof,
			],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(proofAfterFailure.status).not.toBe(0);
		expect(proofAfterFailure.stderr).toContain(
			"capture in progress or interrupted",
		);
		rmSync(join(shots, ".capture-lock"), { recursive: true });
		const proofWithoutLock = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				join(fixtureScripts, "evidence-check.mts"),
				proof,
			],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(proofWithoutLock.status).not.toBe(0);
		expect(proofWithoutLock.stderr).toContain("capture incomplete");
		rmSync(join(shots, ".capture-incomplete"));
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

it("refuses symlinks in evidence paths before reading or probing", () => {
	const packageRoot = resolve(import.meta.dirname, "..");
	const scratch = mkdtempSync(join(tmpdir(), "yard-evidence-boundary-"));
	const shots = join(scratch, "shots");
	const lock = join(shots, ".capture-lock");
	const probes: string[] = [];
	const probe = (path: string) => {
		probes.push(path);
		return {
			status: 0,
			stdout: JSON.stringify({
				streams: [
					{ codec_type: "video", width: 100, height: 100, duration: "2.5" },
				],
				format: { duration: "2.5" },
			}),
			stderr: "",
		};
	};
	try {
		cpSync(join(packageRoot, "public/shots"), shots, { recursive: true });
		const rootAlias = join(scratch, "evidence-root");
		symlinkSync("shots", rootAlias, "dir");
		probes.length = 0;
		expect(validateEvidence(rootAlias, lock, probe)).toBeGreaterThan(0);
		expect(probes).toHaveLength(0);
		for (const name of [
			"evidence-manifest.json",
			"visual-report.json",
			"01-boot-live.png",
		]) {
			const evidence = join(shots, name);
			const external = join(scratch, `external-${name}`);
			renameSync(evidence, external);
			symlinkSync(external, evidence);
			probes.length = 0;
			expect(validateEvidence(shots, lock, probe), name).toBeGreaterThan(0);
			if (name === "evidence-manifest.json") expect(probes).toHaveLength(0);
			rmSync(evidence);
			renameSync(external, evidence);
		}

		const recordings = join(shots, "recordings");
		const video = join(recordings, "01-yard-loop.mp4");
		const externalVideo = join(scratch, "external-video.mp4");
		renameSync(video, externalVideo);
		symlinkSync(externalVideo, video);
		probes.length = 0;
		expect(validateEvidence(shots, lock, probe)).toBeGreaterThan(0);
		expect(probes).toHaveLength(3);
		expect(probes).not.toContain(externalVideo);
		rmSync(video);
		renameSync(externalVideo, video);

		const manifestPath = join(shots, "evidence-manifest.json");
		const manifestBytes = readFileSync(manifestPath);
		const manifest: {
			files: Record<string, { bytes: number; sha256: string }>;
		} = JSON.parse(manifestBytes.toString("utf8"));
		const externalExtra = join(scratch, "external-extra.txt");
		const extraBytes = Buffer.from("outside evidence\n");
		writeFileSync(externalExtra, extraBytes);
		symlinkSync(externalExtra, join(shots, "extra.txt"));
		manifest.files["extra.txt"] = {
			bytes: extraBytes.length,
			sha256: createHash("sha256").update(extraBytes).digest("hex"),
		};
		writeFileSync(manifestPath, JSON.stringify(manifest));
		expect(validateEvidence(shots, lock, probe)).toBeGreaterThan(0);
		rmSync(join(shots, "extra.txt"));
		writeFileSync(manifestPath, manifestBytes);

		const externalRecordings = join(scratch, "external-recordings");
		renameSync(recordings, externalRecordings);
		symlinkSync(externalRecordings, recordings, "dir");
		probes.length = 0;
		expect(validateEvidence(shots, lock, probe)).toBeGreaterThan(0);
		expect(probes).toHaveLength(0);
		rmSync(recordings);
		renameSync(externalRecordings, recordings);

		const shot = join(shots, "01-boot-live.png");
		const internalShot = join(shots, "internal-boot.png");
		renameSync(shot, internalShot);
		symlinkSync("internal-boot.png", shot);
		probes.length = 0;
		expect(validateEvidence(shots, lock, probe)).toBeGreaterThan(0);
		rmSync(shot);
		renameSync(internalShot, shot);
		const internalRecordings = join(shots, "internal-recordings");
		renameSync(recordings, internalRecordings);
		symlinkSync("internal-recordings", recordings, "dir");
		probes.length = 0;
		expect(validateEvidence(shots, lock, probe)).toBeGreaterThan(0);
		expect(probes).toHaveLength(0);
		rmSync(recordings);
		renameSync(internalRecordings, recordings);

		const outside = join(scratch, "outside-normalization");
		mkdirSync(join(outside, "nested"), { recursive: true });
		cpSync(shots, join(outside, "shots"), { recursive: true });
		cpSync(shots, join(outside, "target"), { recursive: true });
		const alias = join(scratch, "normalization-alias");
		symlinkSync(join(outside, "nested"), alias, "dir");
		const unnormalized = `${alias}${sep}..${sep}shots`;
		renameSync(shots, join(scratch, "saved-shots"));
		symlinkSync(join(outside, "target"), shots, "dir");
		probes.length = 0;
		expect(validateEvidence(unnormalized, lock, probe)).toBeGreaterThan(0);
		expect(probes).toHaveLength(0);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

it("refuses symlinked evidence roots and checkout path components", () => {
	const packageRoot = resolve(import.meta.dirname, "..");
	const fixtureScratch = mkdtempSync(
		join(tmpdir(), "yard-evidence-root-test-"),
	);
	const fixtureCheckout = join(fixtureScratch, "checkout");
	const fixturePackage = join(fixtureCheckout, "packages/control-yard");
	const scripts = join(fixturePackage, "scripts");
	const publicDir = join(fixturePackage, "public");
	const outsidePublic = join(fixtureScratch, "outside-public");
	try {
		mkdirSync(scripts, { recursive: true });
		symlinkSync(
			resolve(packageRoot, "../../node_modules"),
			join(fixturePackage, "node_modules"),
			"dir",
		);
		for (const script of [
			"evidence-check.mts",
			"evidence-validator.mts",
			"capture-failures.mts",
		]) {
			cpSync(join(packageRoot, "scripts", script), join(scripts, script));
		}
		cpSync(join(packageRoot, "public/shots"), join(outsidePublic, "shots"), {
			recursive: true,
		});
		mkdirSync(publicDir);
		symlinkSync(join(outsidePublic, "shots"), join(publicDir, "shots"), "dir");
		const runCheck = (directory?: string) =>
			spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					join(scripts, "evidence-check.mts"),
					...(directory ? [directory] : []),
				],
				{ encoding: "utf8", timeout: 20_000 },
			);
		const rootLink = runCheck();
		expect(rootLink.status).not.toBe(0);
		expect(rootLink.stderr).toContain("evidence directory is a symlink");

		rmSync(join(publicDir, "shots"));
		rmSync(publicDir, { recursive: true });
		symlinkSync(outsidePublic, publicDir, "dir");
		const parentLink = runCheck();
		expect(parentLink.status).not.toBe(0);
		expect(parentLink.stderr).toContain(
			"evidence directory traverses a symlink",
		);

		const proofParent = join(
			fixtureCheckout,
			"src/draft/exp-proofs/ux/control-yard",
		);
		const outsideAssets = join(fixtureScratch, "outside-assets");
		mkdirSync(proofParent, { recursive: true });
		cpSync(join(outsidePublic, "shots"), join(outsideAssets, "evidence"), {
			recursive: true,
		});
		symlinkSync(outsideAssets, join(proofParent, "assets"), "dir");
		const proofLink = runCheck(join(proofParent, "assets/evidence"));
		expect(proofLink.status).not.toBe(0);
		expect(proofLink.stderr).toContain(
			"evidence directory traverses a symlink",
		);
	} finally {
		rmSync(fixtureScratch, { recursive: true, force: true });
	}
});

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
			return {
				status: 0,
				stdout: JSON.stringify({
					streams: [
						{ codec_type: "video", width: 100, height: 100, duration: "2.5" },
					],
					format: { duration: "2.5" },
				}),
				stderr: "",
			};
		};
		const validateWithTestProbe = () =>
			validateEvidence(shots, join(shots, ".capture-lock"), testProbe);

		writeFileSync(manifestPath, "{ malformed json");
		const malformed = runCheck();
		expect(malformed.status).not.toBe(0);
		expect(malformed.stderr).toContain(
			"evidence-manifest.json is not valid JSON",
		);
		expect(malformed.stderr).toContain(
			"pnpm --filter @hobo/control-yard run evidence",
		);
		expect(malformed.stderr).not.toContain("SyntaxError");
		saveReport();

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
		const audioOnlyProbe = () => ({
			status: 0,
			stderr: "",
			stdout: JSON.stringify({ streams: [], format: { duration: "2.5" } }),
		});
		expect(
			validateEvidence(shots, join(shots, ".capture-lock"), audioOnlyProbe),
		).toBe(4);
		const shortVideoProbe = () => ({
			status: 0,
			stderr: "",
			stdout: JSON.stringify({
				streams: [
					{ codec_type: "video", width: 100, height: 100, duration: "0.5" },
				],
				format: { duration: "2.5" },
			}),
		});
		expect(
			validateEvidence(shots, join(shots, ".capture-lock"), shortVideoProbe),
		).toBe(4);
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
