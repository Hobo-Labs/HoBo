import fs from "node:fs";
import path from "node:path";

const ROTTED_PATH_FRAGMENTS = [
  "forge-generated-stack.md",
  "event-model.md",
  "verification.md",
  "adr/04-governance-verification.md",
  "adr/05-config-matching-environments.md",
  "adr/06-ai-generation-operators.md",
  "adr/08-scope-and-requirements.md",
] as const;

const LOCAL_LINK_PATTERN = /\]\(([^)#]+\.md)(#[^)]+)?\)/g;

export type LinkScanRoot = "patterns" | "standards";

export function scanPatternsStandardsLinks(repoRoot: string, roots: LinkScanRoot[]) {
  const rottedReferences: Array<{ file: string; fragment: string }> = [];
  const brokenLinks: Array<{ file: string; target: string }> = [];

  for (const root of roots) {
    const directory = path.join(repoRoot, "docs", root);
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith(".md")) continue;

      const file = path.join(directory, entry);
      const relativeFile = path.relative(repoRoot, file).replaceAll("\\", "/");
      const content = fs.readFileSync(file, "utf8");

      for (const fragment of ROTTED_PATH_FRAGMENTS) {
        if (content.includes(fragment)) {
          rottedReferences.push({ file: relativeFile, fragment });
        }
      }

      for (const match of content.matchAll(LOCAL_LINK_PATTERN)) {
        const target = match[1];
        if (target.startsWith("http")) continue;

        const resolved = path.resolve(path.dirname(file), target);
        if (!fs.existsSync(resolved)) {
          brokenLinks.push({ file: relativeFile, target });
        }
      }
    }
  }

  return { rottedReferences, brokenLinks };
}
