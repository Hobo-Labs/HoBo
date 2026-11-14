/**
 * The box daemon's fleet settings (D61): the committed `fleet` block of
 * `.hobo/ci.json` in the daemon's own checkout, beside `runnerRouting`.
 *
 * ADR-0181 R2 keeps routing and fleet information out of the box daemon's
 * environment: committed config is reviewed, and the enrolled `AgentState`
 * is signed. So the authority, the fleet, the tenant, the region, the member
 * name and D58's sandbox settings are read from the file, never from a
 * variable. Only two file paths come from the process
 * (`BOX_MEMBER_PROCESS_PATHS`): where the agent keeps its keys and state, and
 * where the single-use bootstrap token is, for the first start.
 *
 * No block: the box is not a fleet member and takes GitHub's queue alone. A
 * block that is there but is not a fleet setting refuses to start, as the
 * daemon's other invalid settings do. The block holds no secret.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BoxMemberSettingsSchema } from "../project-schema.js";
import { DEFAULT_CI_PROJECT_PATH } from "../relay-routing.js";

/** The only process inputs the box's fleet member reads: file paths. */
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
	/** The agent's key and state directory. */
	home: string;
	/** The bootstrap token's file, read once at first start; never argv or env. */
	bootstrapTokenFile: string | undefined;
}>;

const Document = z.object({ fleet: z.json().optional() });

const path = (value: string | undefined) =>
	value === undefined || value === "" ? undefined : value;

/**
 * The settings in `<checkoutRoot>/.hobo/ci.json`, or undefined when it has no
 * `fleet` block. Throws when the file is not JSON or the block is invalid.
 */
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
