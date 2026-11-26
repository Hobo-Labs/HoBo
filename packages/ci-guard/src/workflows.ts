import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface WorkflowFile {
	readonly name: string;
	readonly path: string;
	readonly content: string;
}

export async function loadWorkflowFiles(dir: string): Promise<WorkflowFile[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
		.map((entry) => entry.name)
		.sort();

	return Promise.all(
		files.map(async (name) => {
			const filePath = path.join(dir, name);
			const content = await readFile(filePath, "utf8");
			return { name, path: filePath, content };
		}),
	);
}
