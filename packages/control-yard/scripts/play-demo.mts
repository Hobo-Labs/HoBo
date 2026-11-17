/** Invalidate previous evidence before loading the capture or its dependencies. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "public/shots");
const proof = join(
	root,
	"../../src/draft/exp-proofs/ux/control-yard/assets/evidence",
);
const lock = join(shots, ".capture-lock");
const markers = [shots, proof].map((dir) => join(dir, ".capture-incomplete"));
let markersReady = false;

mkdirSync(shots, { recursive: true });
try {
	mkdirSync(lock);
} catch (error) {
	throw new Error(
		`Cannot acquire capture lock ${lock}; ensure no capture is running and remove a stale lock before retrying`,
		{ cause: error },
	);
}
try {
	for (const marker of markers) {
		mkdirSync(dirname(marker), { recursive: true });
		writeFileSync(
			marker,
			"Capture incomplete. Run the evidence command again.\n",
		);
	}
	markersReady = true;
	await import("./capture-tour.mts");
	for (const marker of markers) rmSync(marker);
} finally {
	// If either marker could not be written, the lock is the remaining signal
	// that prevents either previous evidence copy from appearing current.
	if (markersReady) rmSync(lock, { recursive: true, force: true });
}
