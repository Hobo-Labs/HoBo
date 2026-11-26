/**
 * Skill-mirror drift gate.
 *
 * The repo-local skills are maintained as byte-identical copies in `.claude/skills/<name>`
 * (Claude Code) and `.agents/skills/<name>` (Cursor/Codex). Nothing previously asserted the
 * two stayed equal, so edits to one mirror silently rotted the other. This gate fails when a
 * mirrored skill differs between the trees.
 *
 * Coverage: every skill directory present in BOTH `.claude/skills/` and `.agents/skills/`
 * is compared byte-for-byte, except those in `VENDORED_SKILLS` — third-party
 * skills whose own installer compiles different files per harness. The REQUIRED_SKILLS below must additionally exist in both
 * trees — a required skill missing from either (or both) mirrors fails the gate. For
 * non-required skills, existing in only one tree passes (deliberately unmirrored), and via
 * `compareSkill` a skill missing on BOTH sides passes (not yet created); a required skill
 * present on only one side fails.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const REQUIRED_SKILLS = ["draft", "repo", "sdlc"];

/**
 * Vendored skills that are *compiled per harness* and must not be compared.
 *
 * The byte-identical rule below is right for skills this repo authors: one
 * source of truth, copied to both trees, where a divergence is rot. It is wrong
 * for a third-party skill installed by its own toolchain, which deliberately
 * emits different files per harness — `impeccable` ships Codex-specific agent
 * manifests (`agents/*.toml`, `agents/openai.yaml`) that have no Claude Code
 * equivalent. Forcing those trees equal would corrupt the install, and the
 * upstream installer would undo it on the next `npx impeccable update`.
 *
 * These are re-installed, never hand-edited, so there is no edit to rot.
 */
const VENDORED_SKILLS = new Set(["impeccable"]);

function listSkillDirs(root: string, tree: string): Set<string> {
	const dir = path.join(root, tree, "skills");
	if (!existsSync(dir)) return new Set();
	return new Set(
		readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name),
	);
}

/** Skills to compare: required ones always, plus every skill present in both trees. */
export function discoverMirroredSkills(root = repoRoot): string[] {
	const claude = listSkillDirs(root, ".claude");
	const agents = listSkillDirs(root, ".agents");
	const shared = [...claude]
		.filter((skill) => agents.has(skill))
		.filter((skill) => !VENDORED_SKILLS.has(skill));
	return [...new Set([...REQUIRED_SKILLS, ...shared])].sort();
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(abs));
		else out.push(abs);
	}
	return out;
}

export function compareSkill(skill: string, root = repoRoot): string[] {
	const problems: string[] = [];
	const claudeDir = path.join(root, ".claude/skills", skill);
	const agentsDir = path.join(root, ".agents/skills", skill);
	const claudeExists = existsSync(claudeDir);
	const agentsExists = existsSync(agentsDir);
	if (!claudeExists && !agentsExists) return problems; // not yet created — pass
	if (claudeExists !== agentsExists) {
		problems.push(
			`skill "${skill}" exists in ${claudeExists ? ".claude" : ".agents"} but not the other mirror`,
		);
		return problems;
	}
	const claudeFiles = new Map(
		listFiles(claudeDir).map((f) => [path.relative(claudeDir, f), f]),
	);
	const agentsFiles = new Map(
		listFiles(agentsDir).map((f) => [path.relative(agentsDir, f), f]),
	);
	for (const [rel, abs] of claudeFiles) {
		const counterpart = agentsFiles.get(rel);
		if (!counterpart) {
			problems.push(`${skill}/${rel} exists only in .claude/skills`);
			continue;
		}
		if (
			statSync(abs).size !== statSync(counterpart).size ||
			!readFileSync(abs).equals(readFileSync(counterpart))
		) {
			problems.push(
				`${skill}/${rel} differs between .claude and .agents mirrors`,
			);
		}
	}
	for (const rel of agentsFiles.keys()) {
		if (!claudeFiles.has(rel))
			problems.push(`${skill}/${rel} exists only in .agents/skills`);
	}
	return problems;
}

function main() {
	const skills = discoverMirroredSkills();
	const problems = skills.flatMap((skill) => compareSkill(skill));
	for (const skill of REQUIRED_SKILLS) {
		if (
			!existsSync(path.join(repoRoot, ".claude/skills", skill)) &&
			!existsSync(path.join(repoRoot, ".agents/skills", skill))
		) {
			problems.push(
				`required skill "${skill}" is missing from both .claude/skills and .agents/skills`,
			);
		}
	}
	if (problems.length > 0) {
		console.error("skill-mirror gate failed:");
		for (const problem of problems) console.error(`  - ${problem}`);
		console.error(
			"\nCopy the edited skill over its mirror so .claude/skills and .agents/skills stay byte-identical.",
		);
		process.exit(1);
	}
	console.log(
		`skill mirrors OK: ${skills.length} skills checked (required: ${REQUIRED_SKILLS.join(", ")}).`,
	);
}

const invokedDirectly =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invokedDirectly) main();
