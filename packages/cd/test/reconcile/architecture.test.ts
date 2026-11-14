// Architecture tests over call sites (I2; D5 OBSERVE_ONLY; I11 for WP7 files).
//   I2  Reconcilers are the only delivery mutators: within @hobo/cd, the
//       mutating realization calls appear only in the reconcile module and the
//       two realizer adapters it drives.
//   D5  OBSERVE_ONLY never reaches a mutating path: Realizer.converge has one
//       call site, inside `mutate`, which returns before it unless the Camp
//       is MANAGED.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../src/", import.meta.url));

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name === "_generated") continue;
			out.push(...sources(path));
		} else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/(^|[^:"'`])\/\/[^\n]*/gu, "$1");
}

// Calls that mutate a delivery target.
const MUTATORS: readonly Readonly<{ name: string; pattern: RegExp }>[] = [
	{ name: "Realizer.converge", pattern: /\.converge\(/u },
	{ name: "runOrchestrator", pattern: /\brunOrchestrator\(/u },
	{ name: "destroyResource", pattern: /\bdestroyResource\(/u },
	{ name: "reconcileResource", pattern: /\breconcileResource\(/u },
	{
		name: "hosting coordinator",
		pattern: /\bcreateHostingTransitionCoordinator\b/u,
	},
	{ name: "PublisherPort.publish", pattern: /\.publish\(\s*\{\s*set\b/u },
	{ name: "IacProvider.apply", pattern: /\biac\.apply\(|\.executor\.run\(/u },
];

const ALLOWED = [
	/^reconcile\//u,
	/^adapters\/orchestrator\.ts$/u,
	/^adapters\/hosting-transition\.ts$/u,
];

describe("architecture", () => {
	it("I2: reconcilers are the only delivery mutators (call sites in @hobo/cd)", () => {
		const offenders: string[] = [];
		for (const file of sources(ROOT)) {
			const rel = relative(ROOT, file).split("\\").join("/");
			if (ALLOWED.some((allowed) => allowed.test(rel))) continue;
			const text = stripComments(readFileSync(file, "utf8"));
			for (const mutator of MUTATORS)
				if (mutator.pattern.test(text))
					offenders.push(`${rel}: ${mutator.name}`);
		}
		expect(offenders).toEqual([]);
	});

	it("an OBSERVE_ONLY Camp produces zero mutating calls: converge has one call site, guarded by MANAGED", () => {
		const reconcileDir = join(ROOT, "reconcile");
		const sites: string[] = [];
		for (const file of sources(reconcileDir)) {
			const text = stripComments(readFileSync(file, "utf8"));
			const matches = text.match(/\.converge\(/gu) ?? [];
			for (const _ of matches) sites.push(relative(reconcileDir, file));
		}
		expect(sites).toEqual(["reconciler.ts"]);
		const text = stripComments(
			readFileSync(join(reconcileDir, "reconciler.ts"), "utf8"),
		);
		const mutate = text.slice(text.indexOf("async function mutate("));
		const body = mutate.slice(0, mutate.indexOf("\n\t}\n"));
		const guard = body.indexOf(
			"if (change.management !== CampManagement.MANAGED) return undefined;",
		);
		const call = body.indexOf(".converge(");
		expect(guard).toBeGreaterThan(-1);
		expect(call).toBeGreaterThan(guard);
	});

	it("I11: reconcile and the WP7 adapters import no provider, runtime, CI, broker, CLI or vendor package", () => {
		const files = [
			...sources(join(ROOT, "reconcile")),
			join(ROOT, "adapters", "orchestrator.ts"),
			join(ROOT, "adapters", "hosting-transition.ts"),
		];
		const forbidden =
			/from "@hobo\/(provider-|iac-|runtime-|ci|broker|cli|hobo|resolver-components)|from "(@kubernetes|kubernetes|@aws-sdk|@azure|@google-cloud|argo|flux)/u;
		const offenders = files.filter((file) =>
			forbidden.test(readFileSync(file, "utf8")),
		);
		expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
	});

	it("decision code reads no wall clock or RNG (I8)", () => {
		const files = sources(join(ROOT, "reconcile"));
		const offenders = files.filter((file) =>
			/\bDate\.now\(|Math\.random\(|crypto\.randomUUID|randomBytes\(/u.test(
				stripComments(readFileSync(file, "utf8")),
			),
		);
		expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
	});
});
