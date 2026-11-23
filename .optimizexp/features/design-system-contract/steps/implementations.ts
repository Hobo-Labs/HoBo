import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkVisualTokens } from "../../../../scripts/check-visual-tokens.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const sitePath = "site/src/styles/global.css";
const connectPath = "packages/connect-ui/src/client/styles.css";

export function inspectPalette(unreadable: boolean): string[] {
  const site = readFileSync(path.join(repoRoot, sitePath), "utf8");
  const connect = readFileSync(path.join(repoRoot, connectPath), "utf8");
  const checked = unreadable ? site.replace("--text: #f2f1ec;", "--text: #0a0a0a;") : site;
  if (unreadable && checked === site) throw new Error("the visual token fixture no longer matches the site palette");
  return checkVisualTokens({ path: sitePath, css: checked }, { path: connectPath, css: connect });
}
