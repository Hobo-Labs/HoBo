import { toJsonString } from "@bufbuild/protobuf";
import { TurboCiPlanSchema } from "./_generated/turbo_ci_pb.js";
import { planTurboCi, runTurboCi, type TurboCiOptions } from "./turbo-ci.js";

const help = `Run Vercel CI-tagged Turbo tasks on this machine.
Usage: pnpm ci:local [--cwd DIR] [--dry-run] [--affected --base REF [--head REF]] [--remote-cache]
Cloud CI must remain disabled separately to avoid duplicate hosted runs.
`;

async function main() {
	const controller = new AbortController();
	const options: TurboCiOptions = {
		cwd: process.cwd(),
		signal: controller.signal,
	};
	let dry = false;
	const args = process.argv.slice(2);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") continue;
		if (arg === "--help") {
			process.stdout.write(help);
			return;
		}
		if (arg === "--dry-run") dry = true;
		else if (arg === "--affected") options.affected = true;
		else if (arg === "--remote-cache") options.remoteCache = true;
		else if (arg === "--cwd" || arg === "--base" || arg === "--head") {
			const value = args[++index];
			if (!value || value.startsWith("-"))
				throw new Error(`missing value for ${arg}`);
			if (arg === "--cwd") options.cwd = value;
			else if (arg === "--base") options.base = value;
			else options.head = value;
		} else throw new Error(`unknown argument: ${arg}`);
	}
	if (options.affected && !options.base)
		throw new Error(
			"affected mode requires --base REF and sufficient Git history",
		);
	const stop = () => controller.abort(new Error("local CI cancelled"));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		if (dry)
			process.stdout.write(
				`${toJsonString(TurboCiPlanSchema, await planTurboCi(options), { prettySpaces: 2, alwaysEmitImplicit: true })}\n`,
			);
		else process.exitCode = await runTurboCi(options);
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}

main().catch((error: Error) => {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
});
