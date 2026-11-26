import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REM037_TARGETS = [
  {
    id: "architecture",
    path: "docs/design/architecture.md",
    forbidden: [
      /ui-generation surface is out of scope/i,
      /`@hobo\/ui-render`.*out of scope/i,
    ],
    required: [/App\/UI generation.*@hobo\/ui-render/i, /ADR-0064.*ADR-0056|ADR-0056.*ADR-0064/s],
  },
  {
    id: "stage-6",
    path: "docs/design/stage-6-production-hardening-acceptance.md",
    forbidden: [/UI-layer generation.*out of scope/i],
    required: [/Marketplace monetization is out of scope/i, /app\/UI generation.*keep list/i],
  },
  {
    id: "worked-example",
    path: "docs/design/worked-example.md",
    forbidden: [/does not generate the developer's product UI/i],
    required: [/UX Designer.*product UI/i, /`ui-render` port/i],
  },
  {
    id: "gap-analysis",
    path: "docs/competitors/gap-analysis.md",
    forbidden: [
      /UI-layer generation was subsequently removed/i,
      /app-build-out.*UI-layer generation/i,
    ],
    required: [/App\/UI generation remains in scope/i, /app\/UI generation stays in the ADR-0064 keep list/i],
  },
] as const;

export type CitationCheckResult = {
  id: string;
  path: string;
  ok: boolean;
  violations: string[];
};

export function checkUiGenerationCitations(repoRoot: string): CitationCheckResult[] {
  return REM037_TARGETS.map((target) => {
    const absolutePath = resolve(repoRoot, target.path);
    const content = readFileSync(absolutePath, "utf8");
    const violations: string[] = [];

    for (const pattern of target.forbidden) {
      if (pattern.test(content)) {
        violations.push(`forbidden pattern matched: ${pattern}`);
      }
    }

    for (const pattern of target.required) {
      if (!pattern.test(content)) {
        violations.push(`required pattern missing: ${pattern}`);
      }
    }

    return {
      id: target.id,
      path: target.path,
      ok: violations.length === 0,
      violations,
    };
  });
}
