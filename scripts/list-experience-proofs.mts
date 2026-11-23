import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EXPERIENCE_TYPES, type ExperienceType } from "./lib/proof-manifest.ts";

const audiences = {
	dx: "Developers and operators",
	ux: "End users",
	cx: "Customers and publishers",
	ax: "Agents",
	api: "API and SDK consumers",
} satisfies Record<ExperienceType, string>;

export type ExperienceProof = {
	type: ExperienceType;
	audience: string;
	slug: string;
	path: string;
};

export function listExperienceProofs(
	root: string,
	selected?: ExperienceType,
): ExperienceProof[] {
	const types = selected ? [selected] : EXPERIENCE_TYPES;
	return types.flatMap((type) => {
		const parent = path.join(root, "src/draft/exp-proofs", type);
		return readdirSync(parent, { withFileTypes: true })
			.filter((entry) => {
				if (!entry.isDirectory()) return false;
				const manifest = path.join(parent, entry.name, "package.json");
				return existsSync(manifest) && statSync(manifest).isFile();
			})
			.map((entry) => ({
				type,
				audience: audiences[type],
				slug: entry.name,
				path: `src/draft/exp-proofs/${type}/${entry.name}`,
			}))
			.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	});
}

function main(argv: string[]): void {
	const { values } = parseArgs({
		args: argv,
		options: {
			help: { type: "boolean", short: "h" },
			json: { type: "boolean" },
			type: { type: "string" },
		},
		strict: true,
	});
	if (values.help) {
		console.log(
			`Usage: pnpm run draft:experiences [--type <${EXPERIENCE_TYPES.join("|")}>] [--json]`,
		);
		return;
	}
	const selected =
		values.type === undefined
			? undefined
			: EXPERIENCE_TYPES.find((type) => type === values.type);
	if (values.type !== undefined && selected === undefined) {
		throw new Error(
			`Unknown experience type ${JSON.stringify(values.type)}; choose ${EXPERIENCE_TYPES.join(", ")}.`,
		);
	}
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const proofs = listExperienceProofs(root, selected);
	if (values.json) {
		console.log(JSON.stringify({ proofs }, null, 2));
		return;
	}
	for (const proof of proofs)
		console.log(`${proof.type}\t${proof.audience}\t${proof.path}`);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
