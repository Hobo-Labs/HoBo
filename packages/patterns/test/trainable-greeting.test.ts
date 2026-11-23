import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadPatternCatalog, renderPattern } from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

it("renders a working trainable greeting with a concrete baseline", () => {
	const root = mkdtempSync(join(tmpdir(), "hobo-trainable-greeting-"));
	try {
		const catalog = loadPatternCatalog();
		const pattern = catalog.patterns.find(
			(candidate) => candidate.id === "http.api.trainable",
		);
		if (!pattern) throw new Error("trainable greeting pattern missing");
		const file = renderPattern({
			catalog,
			pattern,
			params: { name: "greeter" },
		}).files[0];
		if (!file) throw new Error("trainable greeting source missing");
		const modules = join(root, "node_modules");
		mkdirSync(join(modules, "@hobo"), { recursive: true });
		symlinkSync(
			realpathSync(resolve(packageRoot, "node_modules/@hobo/runtime")),
			join(modules, "@hobo/runtime"),
			"dir",
		);
		symlinkSync(
			realpathSync(resolve(packageRoot, "node_modules/hono")),
			join(modules, "hono"),
			"dir",
		);
		writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
		const source = join(root, "api.ts");
		writeFileSync(source, file.contents);
		execFileSync(resolve(packageRoot, "../../node_modules/.bin/tsc"), [
			"--noEmit",
			"--ignoreConfig",
			"--skipLibCheck",
			"--module",
			"NodeNext",
			"--moduleResolution",
			"NodeNext",
			"--target",
			"ES2022",
			source,
		]);
		const output = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				'import { pathToFileURL } from "node:url"; const { app, greet } = await import(pathToFileURL(process.argv[1])); const { getTrainable } = await import("@hobo/runtime"); const named = await app.request("http://localhost/hello?name=Ada"); const fallback = await app.request("http://localhost/hello"); process.stdout.write(JSON.stringify({ named: await named.json(), fallback: await fallback.json(), direct: await greet({name:"Grace"}), baseline: getTrainable("greeter.greet").fact.baseline }));',
				source,
			],
			{ cwd: packageRoot, encoding: "utf8" },
		);
		expect(JSON.parse(output)).toEqual({
			named: { message: "Hello, Ada!" },
			fallback: { message: "Hello, world!" },
			direct: { message: "Hello, Grace!" },
			baseline: "body",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
