import { defineConfig } from "oxlint";

/**
 * anti-slop (vendored Oxlint plugin, https://github.com/dmmulroy/anti-slop):
 * rejects low-evidence / low-signal TypeScript patterns. The plugin is vendored
 * at tools/oxlint/anti-slop/ — edit it there, copy the tree over both skill
 * assets (.agents/skills, .claude/skills install-anti-slop) and regenerate
 * MANIFEST.sha256 in all three (ADR-0173); scripts/test/anti-slop-vendor.test.ts
 * fails on any drift. Install/refresh via the `install-anti-slop` skill.
 */
export default defineConfig({
	ignorePatterns: [
		// Agent tooling + installed skills (skill defaults).
		".agent/**",
		".agents/**",
		".claude/**",
		".codex/**",
		".continue/**",
		".cursor/**",
		".gemini/**",
		".opencode/**",
		".pi/**",
		".roo/**",
		".windsurf/**",
		// Project-local agent/tooling directories.
		".hobo/**",
		".impeccable/**",
		".optimizexp/**",
		".serena/**",
		".tools/**",
		".worktrees/**",
		// Installed agent skills (same class as .claude/.agents, not app source).
		".github/skills/**",
		// Local throwaway trees (untracked in agents' worktrees).
		"barebones/**",
		"demo/**",
		// Vendored third-party source, the plugin itself, and generated output.
		"external/**",
		"tools/oxlint/anti-slop/**",
		"**/_generated/**",
		"**/dist/**",
		"**/node_modules/**",
	],
	jsPlugins: [
		{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
	],
	rules: {
		"anti-slop/no-chained-type-assertions": "error",
		"anti-slop/no-conditional-empty-object-spread": "error",
		"anti-slop/no-known-value-widening": "error",
		"anti-slop/no-module-mocking": "error",
		"anti-slop/no-object-parameters": "error",
		"anti-slop/no-reflect-apply": "error",
		"anti-slop/no-reflect-get": "error",
		"anti-slop/no-runtime-typeof": "error",
		"anti-slop/no-shape-in-symbol-names": "error",
		"anti-slop/no-unknown-parameters": "error",
		"anti-slop/no-unknown-returns": "error",
		"anti-slop/no-unknown-type-aliases": "error",
		"anti-slop/no-unsafe-dictionary-type": "error",
		"anti-slop/no-widen-then-assert": "error",
		"anti-slop/require-safety-comment-for-type-assertion": "error",
	},
});
