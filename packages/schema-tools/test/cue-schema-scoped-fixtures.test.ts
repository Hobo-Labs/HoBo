import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { vetCueConstraints } from "../src/cue.js";
import type { DataModelPackage } from "../src/types.js";
import { makeTempRepo, removeTempRepo } from "./support/temp-workspace.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(removeTempRepo));
});

async function fixturePackage() {
	const root = await makeTempRepo({ withBufTemplate: false });
	roots.push(root);
	const packageDir = join(root, "packages", "mixed");
	const dataModelsDir = join(packageDir, "data-models");
	await mkdir(dataModelsDir, { recursive: true });
	const schemas = {
		"order_line.cue": '#OrderLine: close({kind: "order", qty: int & >0})\n',
		"deployment.cue":
			'#Deployment: close({kind: "deployment", replicas: int & >0})\n',
	};
	for (const [name, schema] of Object.entries(schemas))
		await writeFile(join(dataModelsDir, name), schema);
	const fixtures = {
		"order_line/valid/good.json": { kind: "order", qty: 1 },
		"order_line/invalid/bad.json": { kind: "order", qty: 0 },
		"deployment/valid/good.json": { kind: "deployment", replicas: 1 },
		"deployment/invalid/bad.json": { kind: "deployment", replicas: 0 },
	};
	for (const [name, fixture] of Object.entries(fixtures)) {
		const path = join(dataModelsDir, "fixtures", name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(fixture));
	}
	const pkg: DataModelPackage = {
		name: "mixed",
		packageDir,
		dataModelsDir,
		generatedDir: join(packageDir, "src", "_generated"),
		cueSchemas: Object.keys(schemas).map((name) => join(dataModelsDir, name)),
	};
	return { root, pkg };
}

test("real CUE vets each scoped corpus against its owning schema", async () => {
	const { root, pkg } = await fixturePackage();
	const result = await vetCueConstraints(pkg, root);
	expect(result).toEqual({ ok: true, violations: [] });
});

test("a mismatched record in a scoped valid corpus fails its owning schema", async () => {
	const { root, pkg } = await fixturePackage();
	await writeFile(
		join(pkg.dataModelsDir, "fixtures", "order_line", "valid", "wrong.json"),
		JSON.stringify({ kind: "deployment", replicas: 1 }),
	);
	const result = await vetCueConstraints(pkg, root);
	expect(result.ok).toBe(false);
	expect(result.violations).toHaveLength(1);
	expect(result.violations[0]?.constraint).toBe("order_line.cue");
	expect(result.violations[0]?.message).toContain("wrong.json");
});

test("an accepted record in a scoped invalid corpus fails the negative control", async () => {
	const { root, pkg } = await fixturePackage();
	await writeFile(
		join(pkg.dataModelsDir, "fixtures", "deployment", "invalid", "bad.json"),
		JSON.stringify({ kind: "deployment", replicas: 1 }),
	);
	const result = await vetCueConstraints(pkg, root);
	expect(result.ok).toBe(false);
	expect(result.violations).toHaveLength(1);
	expect(result.violations[0]?.constraint).toBe("deployment.cue");
	expect(result.violations[0]?.message).toContain("expected invalid fixture");
});

test("schema-scoped corpora cannot hide legacy package-wide fixtures", async () => {
	const { root, pkg } = await fixturePackage();
	const directory = join(pkg.dataModelsDir, "fixtures", "valid");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "legacy.json"),
		JSON.stringify({ kind: "other" }),
	);
	const result = await vetCueConstraints(pkg, root);
	expect(result.ok).toBe(false);
	expect(result.violations.map((violation) => violation.constraint)).toEqual([
		"order_line.cue",
		"deployment.cue",
	]);
	expect(
		result.violations.every((violation) =>
			violation.message.includes("legacy.json"),
		),
	).toBe(true);
});

async function splitPackage(schemas: Record<string, string>) {
	const root = await makeTempRepo({ withBufTemplate: false });
	roots.push(root);
	const packageDir = join(root, "packages", "split");
	const dataModelsDir = join(packageDir, "data-models");
	await mkdir(dataModelsDir, { recursive: true });
	for (const [name, schema] of Object.entries(schemas))
		await writeFile(join(dataModelsDir, name), schema);
	const pkg: DataModelPackage = {
		name: "split",
		packageDir,
		dataModelsDir,
		generatedDir: join(packageDir, "src", "_generated"),
		cueSchemas: Object.keys(schemas).map((name) => join(dataModelsDir, name)),
	};
	const writeFixture = async (
		name: string,
		fixture: Readonly<Record<string, string | number>>,
	) => {
		const path = join(dataModelsDir, "fixtures", name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(fixture));
	};
	return { root, pkg, writeFixture };
}

test("a schema may use a definition from a sibling file of the same CUE package", async () => {
	const { root, pkg, writeFixture } = await splitPackage({
		"order.cue":
			'package shop\n\n#Quantity: int & >0\n#Order: close({kind: "order", qty: #Quantity})\n',
		"refund.cue":
			'package shop\n\n#Refund: close({kind: "refund", qty: #Quantity})\n',
	});
	await writeFixture("order/valid/good.json", { kind: "order", qty: 1 });
	await writeFixture("refund/valid/good.json", { kind: "refund", qty: 2 });
	await writeFixture("refund/invalid/bad.json", { kind: "refund", qty: 0 });
	const result = await vetCueConstraints(pkg, root);
	expect(result).toEqual({ ok: true, violations: [] });
});

test("a second CUE package in the same folder is vetted on its own", async () => {
	const { root, pkg, writeFixture } = await splitPackage({
		"order.cue":
			'package shop\n\n#Order: close({kind: "order", qty: int & >0})\n',
		"audit_entry.cue":
			'package shop_audit\n\n#AuditEntry: close({kind: "audit", actor: string & !=""})\n',
	});
	await writeFixture("order/valid/good.json", { kind: "order", qty: 1 });
	await writeFixture("audit_entry/valid/good.json", {
		kind: "audit",
		actor: "ops",
	});
	await writeFixture("audit_entry/invalid/bad.json", {
		kind: "audit",
		actor: "",
	});
	const result = await vetCueConstraints(pkg, root);
	expect(result).toEqual({ ok: true, violations: [] });
});
