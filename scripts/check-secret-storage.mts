#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

export type Mode =
	| { kind: "staged" }
	| { kind: "worktree" }
	| { kind: "base"; ref: string };
export type AddedLine = Readonly<{ line: number; text: string }>;
export type Change = Readonly<{
	file: string;
	created: boolean;
	lines: readonly AddedLine[];
	content: string;
}>;
export type Violation = Readonly<{
	file: string;
	line: number;
	message: string;
}>;

export const OWNER_STORE_PATH =
	"Use HoBo's owner store session instead: the owner connects their own secret store through HoBo MCP's choose_secret_store or the HoBo CLI, and code reads each credential as owner://<NAME> through the session's CredentialResolver (packages/hobo/src/owner-store-session.ts). Agents never store secrets, and the rule in AGENTS.md admits no exceptions.";

export const PER_JOB_TOKEN = "GITHUB_TOKEN";

const WORKFLOW_EXPRESSION = /\$\{\{([\s\S]*?)\}\}/gu;
const STORED_CONTEXT =
	/\b(secrets|vars)\b(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*)|\s*\[\s*['"]([^'"]+)['"]\s*\])?/gu;
const MEMBER_REFERENCE =
	/(?<![\w.$-])(secrets|vars)\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*)/gu;
const INHERITED_SECRETS = /^\s*secrets\s*:\s*inherit\b/u;

const SECRET_FILE_NAMES: readonly RegExp[] = [
	/^\.env(?:\..*)?$/u,
	/^\.envrc$/u,
	/\.(?:pem|key|p8|p12|pfx|jks|keystore|ppk)$/u,
	/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/u,
	/^(?:.*[.-])?kubeconfig(?:\.ya?ml|\.json)?$/u,
	/^\.(?:netrc|pgpass|pypirc|git-credentials|dockercfg)$/u,
	/^(?:credentials|credentials\.json|application_default_credentials\.json)$/u,
	/^secrets?\.(?:json|ya?ml|toml|env|ini)$/u,
];
const SECRET_FILE_PATHS =
	/(?:^|\/)(?:\.kube\/config|\.docker\/config\.json|\.aws\/credentials)$/u;
export const SECRET_FILE_PATHSPECS: readonly string[] = [
	"**/.env",
	"**/.env.*",
	"**/.envrc",
	"**/*.pem",
	"**/*.key",
	"**/*.p8",
	"**/*.p12",
	"**/*.pfx",
	"**/*.jks",
	"**/*.keystore",
	"**/*.ppk",
	"**/id_rsa",
	"**/id_dsa",
	"**/id_ecdsa",
	"**/id_ed25519",
	"**/*kubeconfig*",
	"**/.netrc",
	"**/.pgpass",
	"**/.pypirc",
	"**/.git-credentials",
	"**/.dockercfg",
	"**/credentials",
	"**/credentials.json",
	"**/application_default_credentials.json",
	"**/secret.*",
	"**/secrets.*",
	"**/.kube/config",
	"**/.docker/config.json",
].map((glob) => `:(glob)${glob}`);

const REGISTRY_FILES = /^(?:\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pypirc)$/u;
const REGISTRY_AUTH =
	/(?:_authToken|_auth|_password|npmAuthToken|npmAuthIdent|^\s*password)\s*[=:]/u;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;

const CREDENTIAL_NAME =
	/(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|KEY|PAT)$|(?:^|_)CREDENTIALS?(?:_|$)|^(?:INFISICAL|BWS|OP_SERVICE_ACCOUNT|OP_CONNECT)_/u;
const ENV_MEMBER_READ =
	/\b(?:process\.env|import\.meta\.env|Bun\.env|env)\s*(?:\?\.)?\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"`]([^'"`]+)['"`]\s*\])/gu;
const ENV_CALL_READ =
	/\b(?:Deno\.env\.get|os\.getenv|os\.Getenv|os\.LookupEnv|env::var(?:_os)?|System\.getenv|os\.environ\.get|ENV\.fetch|getenv)\s*\(\s*['"`]([^'"`]+)['"`]/gu;
const ENV_INDEX_READ =
	/\b(?:os\.environ|ENV)\s*\[\s*['"`]([^'"`]+)['"`]\s*\]/gu;
const ENV_DESTRUCTURE =
	/\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env|Bun\.env|env)\b/gu;
const SHELL_READ = /\$\{?([A-Z_][A-Z0-9_]*)\b/gu;
const ENVIRONMENT_LOCATOR = /\benv:\/\/([A-Za-z_][A-Za-z0-9_.-]*)/gu;

export const STORE_COORDINATE_KEYS: readonly string[] = [
	"projectId",
	"relayIdentityId",
	"deployIdentityId",
	"deployCredentialIdentityId",
	"deployProjectId",
	"vercelTeamId",
	"teamId",
	"deployOidcSubject",
	"claimBundleId",
];
const COORDINATE_ASSIGNMENT = new RegExp(
	`(?<![A-Za-z0-9_])["']?(${STORE_COORDINATE_KEYS.join("|")})["']?\\s*[:=]\\s*["'\`]?([A-Za-z0-9_-]+)`,
	"gu",
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VERCEL_ID = /^(?:team|prj)_([A-Za-z0-9]+)$/u;
const COORDINATE_TOKEN =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b(?:team|prj)_[A-Za-z0-9]+/giu;
const FIXTURE_SEGMENTS = new Set([
	"fixtures",
	"__fixtures__",
	"test",
	"tests",
	"testdata",
	"__tests__",
]);
const BINDING_FILE = /\.binding\.json$/u;
const BUNDLED_BINDING = /(?:^|\/)deploy\/secret-store\.binding\.json$/u;
export const STORE_COORDINATES_PRIVATE =
	"Store coordinates (store project, identity, team and deploy project ids, OIDC subjects, claim bundle ids) are the owner's private settings: they live only in the owner's secret store, which HoBo reads through the owner store session (HoBo MCP's choose_secret_store), and are never committed, printed, or set as environment variables. Fixtures use obviously synthetic values such as all-zero UUIDs.";

export function isRealLookingCoordinate(value: string): boolean {
	if (UUID.test(value)) {
		const digits = value.replace(/-/gu, "").toLowerCase();
		return new Set(digits).size >= 6 && digits.replace(/0/gu, "").length >= 12;
	}
	const suffix = VERCEL_ID.exec(value)?.[1];
	return (
		suffix !== undefined && suffix.length >= 16 && new Set(suffix).size >= 10
	);
}

export function isFixturePath(file: string): boolean {
	return file.split("/").some((segment) => FIXTURE_SEGMENTS.has(segment));
}

function realLookingTokens(text: string): string[] {
	return [...text.matchAll(COORDINATE_TOKEN)]
		.map((match) => match[0])
		.filter(isRealLookingCoordinate);
}

function coordinateViolations(change: Change): Violation[] {
	const { file, content } = change;
	const found: Violation[] = [];
	if (change.created && BUNDLED_BINDING.test(file))
		found.push({
			file,
			line: 1,
			message: `adds the store binding HoBo bundles into a deployment it builds. That file exists only inside a build and is never committed. ${STORE_COORDINATES_PRIVATE}`,
		});
	else if (
		change.created &&
		BINDING_FILE.test(basename(file)) &&
		!isFixturePath(file) &&
		realLookingTokens(content).length > 0
	)
		found.push({
			file,
			line: 1,
			message: `adds a binding file with real-looking store coordinates. ${STORE_COORDINATES_PRIVATE}`,
		});
	for (const added of change.lines)
		for (const match of added.text.matchAll(COORDINATE_ASSIGNMENT)) {
			const key = match[1] ?? "";
			const value = match[2] ?? "";
			if (isRealLookingCoordinate(value))
				found.push({
					file,
					line: added.line,
					message: `adds a real-looking store coordinate under ${key}. ${STORE_COORDINATES_PRIVATE}`,
				});
		}
	return found;
}

const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".astro",
	".vue",
	".svelte",
	".py",
	".go",
	".rs",
	".rb",
	".java",
	".kt",
	".swift",
	".lua",
	".php",
	".cs",
	".sh",
	".bash",
	".zsh",
]);
const SHELL_EXTENSIONS = new Set([".sh", ".bash", ".zsh"]);
const MARKDOWN = /\.(?:md|mdx|markdown)$/iu;

type StoringCommand = Readonly<{
	pattern: RegExp;
	what: string;
	outsideHoboCodeOnly: boolean;
}>;

export const STORING_COMMANDS: readonly StoringCommand[] = [
	{
		pattern: /\bgh\s+(?:secret|variable)\s+(?:set|delete|remove)\b/u,
		what: "creates or changes a GitHub Actions secret or variable",
		outsideHoboCodeOnly: false,
	},
	{
		pattern: /\bgh\s+api\b.*\/actions\/(?:secrets|variables)\b/u,
		what: "writes GitHub Actions secrets or variables through the API",
		outsideHoboCodeOnly: false,
	},
	{
		pattern: /\bvercel\s+env\s+(?:add|rm|remove|pull)\b/u,
		what: "stores Vercel environment variables or pulls them into a local file",
		outsideHoboCodeOnly: false,
	},
	{
		pattern:
			/\b(?:infisical\s+secrets\s+(?:set|delete)|op\s+item\s+(?:create|edit)|bws\s+secret\s+(?:create|edit))\b/u,
		what: "writes a secret store entry outside HoBo's own store code",
		outsideHoboCodeOnly: true,
	},
	{
		pattern:
			/(?:>>?|\btee(?:\s+-a)?)\s*["']?(?:[^\s"'|;&]*\/)?\.env(?:\.[A-Za-z0-9_-]+)?["']?(?=$|[\s;&|)])/u,
		what: "writes a .env file",
		outsideHoboCodeOnly: false,
	},
	{
		pattern: /\bgit\s+config\b.*\bcredential\.helper\s+["']?store\b/u,
		what: "keeps credentials in git's plain-text credential store",
		outsideHoboCodeOnly: false,
	},
	{
		pattern: /\bnpm\s+(?:config\s+set\b.*_auth|login\b|adduser\b)/u,
		what: "stores an npm registry credential",
		outsideHoboCodeOnly: false,
	},
];
const EXPORTED_VARIABLE =
	/\b(?:export|setenv|set\s+-x|setx)\s+([A-Za-z_][A-Za-z0-9_]*)(?:=|\s)/gu;

export function isCredentialName(name: string): boolean {
	const upper = name.toUpperCase();
	return upper !== PER_JOB_TOKEN && CREDENTIAL_NAME.test(upper);
}

export function isSecretFile(file: string): boolean {
	const name = basename(file);
	return (
		SECRET_FILE_PATHS.test(file) ||
		SECRET_FILE_NAMES.some((pattern) => pattern.test(name))
	);
}

export function storingCommandIn(text: string, file = ""): string | undefined {
	for (const command of STORING_COMMANDS) {
		if (command.outsideHoboCodeOnly && file.startsWith("packages/")) continue;
		if (command.pattern.test(text)) return command.what;
	}
	for (const match of text.matchAll(EXPORTED_VARIABLE)) {
		const name = match[1];
		if (name !== undefined && isCredentialName(name))
			return `exports the credential variable ${name}`;
	}
	return undefined;
}

function fencedLines(content: string): Set<number> {
	const fenced = new Set<number>();
	let fence: string | undefined;
	content.split(/\r?\n/u).forEach((text, index) => {
		const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(text)?.[1];
		if (fence === undefined) {
			if (marker !== undefined) {
				fence = marker;
				fenced.add(index + 1);
			}
			return;
		}
		fenced.add(index + 1);
		if (marker !== undefined && marker.startsWith(fence)) fence = undefined;
	});
	return fenced;
}

function isShell(file: string, content: string): boolean {
	return (
		SHELL_EXTENSIONS.has(extname(file).toLowerCase()) ||
		file.startsWith(".githooks/") ||
		(extname(file) === "" && /^#!.*\b(?:sh|bash|zsh)\b/u.test(content))
	);
}

function isCode(file: string, content: string): boolean {
	return (
		CODE_EXTENSIONS.has(extname(file).toLowerCase()) || isShell(file, content)
	);
}

function credentialReads(text: string, shell: boolean): string[] {
	const names: string[] = [];
	for (const pattern of [ENV_MEMBER_READ, ENV_CALL_READ, ENV_INDEX_READ])
		for (const match of text.matchAll(pattern)) {
			const name = match[1] ?? match[2];
			if (name !== undefined) names.push(name);
		}
	for (const match of text.matchAll(ENV_DESTRUCTURE))
		for (const part of (match[1] ?? "").split(","))
			names.push(part.split(":")[0]?.trim() ?? "");
	if (shell)
		for (const match of text.matchAll(SHELL_READ))
			if (match[1] !== undefined) names.push(match[1]);
	return [...new Set(names.filter(isCredentialName))];
}

function workflowViolations(file: string, added: AddedLine): Violation[] {
	const found: Violation[] = [];
	if (INHERITED_SECRETS.test(added.text))
		found.push({
			file,
			line: added.line,
			message: `passes every stored GitHub Actions secret to a called workflow. ${OWNER_STORE_PATH}`,
		});
	const references = [
		...added.text.matchAll(MEMBER_REFERENCE),
		...[...added.text.matchAll(WORKFLOW_EXPRESSION)].flatMap((expression) =>
			[...(expression[1] ?? "").matchAll(STORED_CONTEXT)].filter(
				(reference) => reference[2] === undefined,
			),
		),
	];
	for (const reference of references) {
		const context = reference[1];
		const name = reference[2] ?? reference[3];
		if (context === "secrets" && name === PER_JOB_TOKEN) continue;
		const kind = context === "vars" ? "variable" : "secret";
		found.push({
			file,
			line: added.line,
			message: `reads the stored GitHub Actions ${kind} ${name ?? `context ${context}`}. Only the per-job ${PER_JOB_TOKEN} (secrets.${PER_JOB_TOKEN} or github.token), which GitHub mints for each job and nobody stores, is permitted. ${OWNER_STORE_PATH}`,
		});
	}
	return found;
}

export function secretStorageViolations(
	changes: readonly Change[],
): Violation[] {
	const violations: Violation[] = [];
	for (const change of changes) {
		const { file, content } = change;
		if (change.created && isSecretFile(file))
			violations.push({
				file,
				line: 1,
				message: `adds a secret or credential file. Agents keep no .env files, keys, kubeconfigs or other local secret files, not even examples. ${OWNER_STORE_PATH}`,
			});
		violations.push(...coordinateViolations(change));
		const code = isCode(file, content);
		const shell = isShell(file, content);
		const fenced = MARKDOWN.test(file) ? fencedLines(content) : undefined;
		const registry = REGISTRY_FILES.test(basename(file));
		for (const added of change.lines) {
			const at = { file, line: added.line };
			if (file.startsWith(".github/"))
				violations.push(...workflowViolations(file, added));
			if (registry && REGISTRY_AUTH.test(added.text))
				violations.push({
					...at,
					message: `stores a package registry credential. ${OWNER_STORE_PATH}`,
				});
			if (PRIVATE_KEY_BLOCK.test(added.text))
				violations.push({
					...at,
					message: `adds private key material. ${OWNER_STORE_PATH}`,
				});
			for (const locator of added.text.matchAll(ENVIRONMENT_LOCATOR))
				violations.push({
					...at,
					message: `references the credential locator env://${locator[1]}, which reads a credential from the process environment. HoBo refuses env:// locators; name the entry owner://${locator[1]}. ${OWNER_STORE_PATH}`,
				});
			if (code)
				for (const name of credentialReads(added.text, shell))
					violations.push({
						...at,
						message: `reads the credential ${name} from the environment. ${OWNER_STORE_PATH}`,
					});
			if (fenced === undefined || fenced.has(added.line)) {
				const what = storingCommandIn(added.text, file);
				if (what !== undefined)
					violations.push({
						...at,
						message: `runs a command that ${what}. ${OWNER_STORE_PATH}`,
					});
			}
		}
	}
	return violations;
}

function git(args: readonly string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"core.quotePath=false",
			"-c",
			"diff.noprefix=false",
			"--literal-pathspecs",
			...args,
		],
		{
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
}

function globGit(args: readonly string[]): string {
	return execFileSync("git", args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function diffArgs(mode: Mode): string[] {
	if (mode.kind === "staged") return ["diff", "--cached"];
	if (mode.kind === "worktree") return ["diff", "HEAD"];
	const commit = git([
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${mode.ref}^{commit}`,
	]).trim();
	return ["diff", git(["merge-base", commit, "HEAD"]).trim(), "HEAD"];
}

function mergeParentArgs(mode: Mode): string[][] {
	if (mode.kind !== "staged") return [];
	const path = git(["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
	let heads: string[];
	try {
		heads = readFileSync(path, "utf8").split("\n").filter(Boolean);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
	return heads.map((head) => ["diff", "--cached", head]);
}

function names(args: readonly string[], filter: string): string[] {
	return git([
		...args,
		"--find-renames",
		"--name-only",
		`--diff-filter=${filter}`,
		"-z",
		"--",
	])
		.split("\0")
		.filter(Boolean);
}

export function addedLineNumbers(patch: string): Set<number> {
	const added = new Set<number>();
	let line: number | undefined;
	for (const text of patch.split("\n")) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
		if (hunk) line = Number(hunk[1]);
		else if (line !== undefined && text.startsWith("+")) added.add(line++);
		else if (line !== undefined && text.startsWith(" ")) line++;
	}
	return added;
}

function addedIn(args: readonly string[], file: string): Set<number> {
	return addedLineNumbers(
		git([...args, "--no-color", "--no-ext-diff", "--unified=0", "--", file]),
	);
}

function contents(mode: Mode, file: string): string {
	if (mode.kind === "staged") return git(["show", `:${file}`]);
	if (mode.kind === "base") return git(["show", `HEAD:${file}`]);
	return readFileSync(file, "utf8");
}

function untracked(mode: Mode): string[] {
	if (mode.kind !== "worktree") return [];
	const plain = globGit(["ls-files", "--others", "--exclude-standard", "-z"]);
	const ignored = globGit([
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"-z",
		"--",
		...SECRET_FILE_PATHSPECS,
		":(exclude,glob)**/node_modules/**",
	]);
	return [
		...new Set(
			`${plain}${ignored}`
				.split("\0")
				.filter(Boolean)
				.filter(
					(file) =>
						!file.split("/").includes("node_modules") &&
						(plain.includes(`${file}\0`) || isSecretFile(file)),
				),
		),
	];
}

export function collectChanges(mode: Mode): Change[] {
	const args = diffArgs(mode);
	const parents = mergeParentArgs(mode);
	const created = new Set(names(args, "ACR"));
	const extra = untracked(mode);
	const files = [...new Set([...names(args, "ACMRT"), ...extra])];
	return files.map((file) => {
		const whole = extra.includes(file);
		let content: string;
		try {
			content = contents(mode, file);
		} catch {
			content = "";
		}
		const lines = content.includes("\0") ? [] : content.split(/\r?\n/u);
		let numbers = whole
			? new Set(lines.map((_, index) => index + 1))
			: addedIn(args, file);
		for (const parent of parents) {
			const fromParent = addedIn(parent, file);
			numbers = new Set([...numbers].filter((line) => fromParent.has(line)));
		}
		return {
			file,
			created: whole || created.has(file),
			content,
			lines: [...numbers]
				.sort((left, right) => left - right)
				.map((line) => ({ line, text: lines[line - 1] ?? "" })),
		};
	});
}

function main(args: readonly string[]): number {
	const base = args.find((arg) => arg.startsWith("--base="));
	const mode: Mode = args.includes("--staged")
		? { kind: "staged" }
		: args.includes("--worktree")
			? { kind: "worktree" }
			: { kind: "base", ref: base?.slice("--base=".length) ?? "HEAD~1" };
	try {
		const violations = secretStorageViolations(collectChanges(mode));
		for (const violation of violations)
			console.error(
				`${violation.file}:${violation.line}: ${violation.message}`,
			);
		if (violations.length > 0) return 1;
		console.log(
			"secrets:guard: no stored secrets, secret files, or environment credential reads added",
		);
		return 0;
	} catch (error) {
		console.error(
			`secrets:guard: unable to inspect changes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main(process.argv.slice(2));
