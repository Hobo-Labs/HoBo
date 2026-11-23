import {
	cp,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function temporaryHelloBindle(sourceDir: string): Promise<string> {
	const projectDir = await mkdtemp(
		join(
			fileURLToPath(new URL("../../", import.meta.url)),
			".hello-bindle-test-",
		),
	);
	try {
		await cp(sourceDir, projectDir, {
			recursive: true,
			filter: (source) =>
				source !== join(sourceDir, ".hobo") &&
				source !== join(sourceDir, "node_modules"),
		});
		const tsconfigPath = join(projectDir, "tsconfig.json");
		const tsconfig = await readFile(tsconfigPath, "utf8");
		const originalBase = '"../../tsconfig.base.json"';
		if (!tsconfig.includes(originalBase))
			throw new Error(
				"example tsconfig base changed; update the temporary fixture",
			);
		await writeFile(
			tsconfigPath,
			tsconfig.replace(
				originalBase,
				JSON.stringify(resolve(sourceDir, "../../tsconfig.base.json")),
			),
		);
		await symlink(
			join(sourceDir, "node_modules"),
			join(projectDir, "node_modules"),
			"dir",
		);
		return projectDir;
	} catch (error) {
		await rm(projectDir, { recursive: true, force: true });
		throw error;
	}
}
