import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BoxMemberSettingsSchema } from "../project-schema.js";
import { DEFAULT_CI_PROJECT_PATH } from "../relay-routing.js";

export const BOX_MEMBER_PROCESS_PATHS: readonly string[] = Object.freeze([
	"HOBO_FLEET_HOME",
	"HOBO_FLEET_BOOTSTRAP_TOKEN_FILE",
]);

/** domain-view: the parsed `fleet` block plus the two process paths, resolved. */
export type BoxMemberSettings = Readonly<{
	authorityUrl: string;
	fleet: string;
	tenant: string;
	region: string;
	memberName: string | undefined;
	sandbox: Readonly<{
		runtime: string | undefined;
		cache: string | undefined;
		download: boolean;
	}>;
	home: string;
	bootstrapTokenFile: string | undefined;
}>;

const Document = z.object({ fleet: z.json().optional() });

const path = (value: string | undefined) =>
	value === undefined || value === "" ? undefined : value;

export function readBoxMemberSettings(
	checkoutRoot: string,
	env: Readonly<Record<string, string | undefined>>,
	options: Readonly<{ journalDirectory?: string }> = {},
): BoxMemberSettings | undefined {
	const file = join(checkoutRoot, DEFAULT_CI_PROJECT_PATH);
	if (!existsSync(file)) return undefined;
	let document: z.infer<typeof Document>;
	try {
		document = Document.parse(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		throw new Error(`invalid ${DEFAULT_CI_PROJECT_PATH}: not a JSON object`);
	}
	if (document.fleet === undefined) return undefined;
	const parsed = BoxMemberSettingsSchema.safeParse(document.fleet);
	if (!parsed.success)
		throw new Error(
			`invalid fleet in ${DEFAULT_CI_PROJECT_PATH}: see schema/ci-project.schema.json`,
		);
	const block = parsed.data;
	return {
		authorityUrl: block.authorityUrl,
		fleet: block.fleet,
		tenant: block.tenant,
		region: block.region,
		memberName: block.memberName,
		sandbox: {
			runtime: block.sandbox?.runtime,
			cache: block.sandbox?.cache,
			download: block.sandbox?.download ?? true,
		},
		home:
			path(env.HOBO_FLEET_HOME) ??
			(options.journalDirectory === undefined
				? join(homedir(), ".local", "state", "hobo-fleet-member")
				: join(options.journalDirectory, "fleet-member")),
		bootstrapTokenFile: path(env.HOBO_FLEET_BOOTSTRAP_TOKEN_FILE),
	};
}
