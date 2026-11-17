import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeCaptureDestinations } from "./capture-preflight.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "public/shots");
const proof = join(
	root,
	"../../src/draft/exp-proofs/ux/control-yard/assets/evidence",
);
const lock = join(shots, ".capture-lock");
const markers = [shots, proof].map((dir) => join(dir, ".capture-incomplete"));
let lockMayBeReleased = false;

assertSafeCaptureDestinations(join(root, "../.."), [shots, proof]);
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
	lockMayBeReleased = true;
	await import("./capture-tour.mts");
	lockMayBeReleased = false;
	for (const marker of markers) rmSync(marker);
	lockMayBeReleased = true;
} finally {
	if (lockMayBeReleased) rmSync(lock, { recursive: true, force: true });
}
