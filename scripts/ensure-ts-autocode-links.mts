import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const trainingMarker = join(
	root,
	"external/ts-autocode/packages/training/node_modules/@agentv/core/package.json",
);
/** Hoisted for @hobo/runtime — not at repo root (pnpm.overrides only). */
const groundingMarker = join(
	root,
	"packages/runtime/node_modules/ts-autocode-grounding/package.json",
);

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function linked(): Promise<boolean> {
	return (await exists(trainingMarker)) && (await exists(groundingMarker));
}

async function fetchPins(): Promise<void> {
	const result = spawnSync("pnpm", ["run", "pins:fetch", "ts-autocode"], {
		cwd: root,
		env: process.env,
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(
			"`pnpm run pins:fetch ts-autocode` failed; ts-autocode sibling is required",
		);
	}
}

if (!(await linked())) {
	await fetchPins();
	if (!(await linked())) {
		const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
			cwd: root,
			env: process.env,
			stdio: "inherit",
		});
		if (install.status !== 0) {
			throw new Error(
				"pnpm install failed after pins:fetch; cannot link ts-autocode consumers",
			);
		}
	}
}

if (!(await linked())) {
	throw new Error(
		"ts-autocode sibling packages are not linked (packages/runtime/node_modules/ts-autocode-grounding and ts-autocode-training cone); run `pnpm run pins:fetch` then `pnpm install`",
	);
}
