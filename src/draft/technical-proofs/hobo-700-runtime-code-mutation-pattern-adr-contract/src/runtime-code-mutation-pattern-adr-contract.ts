import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_CODE_MUTATION_PATTERN_REL = "docs/patterns/runtime-code-mutation-persistence.md";

export const REQUIRED_ADR0048_LINK =
  "../design/adr/03-data-plane.md#adr-0048";

export const RETARGETED_LINKS = [
  "../design/generated-stack.md#plan-23",
  "../design/data-plane.md#plan-11",
  "../design/adr/03-data-plane.md#adr-0025",
  "../design/adr/01-architecture-core.md#adr-0037",
  "../design/generated-stack.md#plan-09",
] as const;

export const STALE_LINK_FRAGMENTS = [
  "forge-generated-stack.md",
  "event-model.md",
  "06-ai-generation-operators.md",
  "05-config-matching-environments.md",
  "verification.md#plan-09",
] as const;

export const STALE_UNANSWERED_FRAMING = /\bunanswered\b/i;

export interface PatternAdrLinkGate {
  ok: boolean;
  errors: string[];
}

function repoRootFromModule(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..", "..");
}

export function readRuntimeCodeMutationPattern(repoRoot = repoRootFromModule()): string {
  return readFileSync(path.join(repoRoot, RUNTIME_CODE_MUTATION_PATTERN_REL), "utf8");
}

export function evaluateRuntimeCodeMutationPatternAdrLinks(
  content: string,
): PatternAdrLinkGate {
  const errors: string[] = [];

  if (!content.includes(REQUIRED_ADR0048_LINK)) {
    errors.push("missing ADR-0048 link target in pattern doc");
  }

  const relevanceSection = content.split("## Sources")[0] ?? content;
  if (!relevanceSection.includes(REQUIRED_ADR0048_LINK)) {
    errors.push("ADR-0048 must appear in Relevance to HoBo, not only Sources");
  }

  for (const stale of STALE_LINK_FRAGMENTS) {
    if (content.includes(stale)) {
      errors.push(`stale link fragment remains: ${stale}`);
    }
  }

  if (STALE_UNANSWERED_FRAMING.test(content)) {
    errors.push('pattern doc still frames write-back as "unanswered" without historical deferral');
  }

  for (const link of RETARGETED_LINKS) {
    if (!content.includes(link)) {
      errors.push(`missing retargeted link: ${link}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
