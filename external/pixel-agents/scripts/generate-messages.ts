import { TypeScriptGenerator } from '@asyncapi/modelina';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const YAML_PATH = path.join(REPO_ROOT, 'core', 'asyncapi.yaml');
const OUTPUT_PATH = path.join(REPO_ROOT, 'core', 'src', 'messages.ts');

async function main(): Promise<void> {
  if (!fs.existsSync(YAML_PATH)) {
    console.error(`[generate-messages] ${YAML_PATH} not found.`);
    process.exit(1);
  }

  const generator = new TypeScriptGenerator({
    modelType: 'interface',
    enumType: 'union',
    mapType: 'record',
    moduleSystem: 'ESM',
    useJavascriptReservedKeywords: false,
    constraints: {
      propertyKey: ({ objectPropertyModel }) => objectPropertyModel.propertyName,
      constant: ({ constrainedMetaModel }) => {
        const constOptions = constrainedMetaModel.options?.const;
        return constOptions ? `'${String(constOptions.originalInput)}'` : undefined;
      },
    },
  });

  const yaml = fs.readFileSync(YAML_PATH, 'utf-8');
  const models = await generator.generate(yaml);

  const filtered = models.filter((m) => {
    const isAnon = m.modelName.startsWith('AnonymousSchema_');
    const isEnum = m.model.constructor.name === 'ConstrainedEnumModel';
    if (!isAnon || !isEnum) return true;
    const enumModel = m.model as { values?: unknown[] };
    return (enumModel.values?.length ?? 0) > 1;
  });

  const leakingAnon = filtered.filter((m) => m.modelName.startsWith('AnonymousSchema_'));
  if (leakingAnon.length > 0) {
    console.warn(
      `[generate-messages] WARNING: ${leakingAnon.length} anonymous schema(s) leaked into output: ` +
        leakingAnon.map((m) => m.modelName).join(', ') +
        '. Consider extracting them to named schemas in core/asyncapi.yaml.',
    );
  }

  const body = filtered.map((m) => exportify(m.result)).join('\n\n');

  fs.writeFileSync(OUTPUT_PATH, body + '\n', 'utf-8');
  console.log(`[generate-messages] wrote ${OUTPUT_PATH} (${filtered.length} models)`);

  try {
    execSync(`npx prettier --write ${quote(OUTPUT_PATH)}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('[generate-messages] prettier failed:', err);
    process.exit(1);
  }
  try {
    execSync(`npx eslint --fix ${quote(path.relative(REPO_ROOT, OUTPUT_PATH))}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn('[generate-messages] eslint --fix reported issues (non-fatal).');
  }
}

function exportify(decl: string): string {
  const trimmed = decl.trimStart();
  if (trimmed.startsWith('export ')) return decl;
  return `export ${trimmed}`;
}

function quote(s: string): string {
  if (process.platform === 'win32') {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

main().catch((err) => {
  console.error('[generate-messages] failed:', err);
  process.exit(1);
});
