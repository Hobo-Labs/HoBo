import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { conciseGeneratedTypeScript } from "../packages/schema-tools/src/generated-typescript.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
	options: {
		check: { type: "boolean", default: false },
		output: { type: "string" },
	},
});
const target = values.output
	? resolve(values.output)
	: join(root, "packages/conformance/src/_generated/sdk_conformance_pb.ts");
const temporary = mkdtempSync(join(tmpdir(), "hobo-sdk-proto-"));
try {
	execFileSync(
		process.execPath,
		[
			join(root, "node_modules/@bufbuild/buf/bin/buf"),
			"generate",
			"packages/conformance/data-models",
			"--path",
			"packages/conformance/data-models/sdk_conformance.proto",
			"--template",
			"buf.gen.yaml",
			"-o",
			temporary,
		],
		{
			cwd: root,
			stdio: "pipe",
			env: {
				...process.env,
				PATH: [join(root, "node_modules/.bin"), process.env.PATH ?? ""].join(
					delimiter,
				),
			},
		},
	);
	const generated = `${conciseGeneratedTypeScript(
		readFileSync(join(temporary, "sdk_conformance_pb.ts"), "utf8"),
	).trimEnd()}\n`;
	if (values.check) {
		if (!existsSync(target) || readFileSync(target, "utf8") !== generated) {
			throw new Error(
				"SDK protobuf output is stale; run pnpm --filter @hobo/conformance codegen:sdk",
			);
		}
		console.log("SDK protobuf output is current");
	} else {
		writeFileSync(target, generated);
		console.log(`wrote ${target}`);
	}
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
