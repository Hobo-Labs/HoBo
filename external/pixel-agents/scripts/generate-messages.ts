import { TypeScriptGenerator } from '@asyncapi/modelina';
import { ESLint } from 'eslint';
import * as fs from 'fs';
import * as path from 'path';
import * as prettier from 'prettier';

const REPO_ROOT = path.resolve(__dirname, '..');
const YAML_PATH = path.join(REPO_ROOT, 'core', 'asyncapi.yaml');
const OUTPUT_PATH = path.join(REPO_ROOT, 'core', 'src', 'messages.ts');

async function main(): Promise<void> {
  const outputArg = process.argv.indexOf('--output');
  const outputFile = outputArg < 0 ? OUTPUT_PATH : process.argv[outputArg + 1];
  if (!outputFile || outputFile.startsWith('--')) {
    throw new Error('--output requires a file path');
  }
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

  const formatted = await prettier.format(body + '\n', {
    ...(await prettier.resolveConfig(OUTPUT_PATH)),
    filepath: OUTPUT_PATH,
  });
  const [linted] = await new ESLint({ cwd: REPO_ROOT, fix: true }).lintText(formatted, {
    filePath: OUTPUT_PATH,
  });
  if (linted.errorCount > 0) {
    throw new Error(`generated messages have ${linted.errorCount} lint error(s)`);
  }
  const output = linted.output ?? formatted;
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(outputFile) || fs.readFileSync(outputFile, 'utf-8') !== output) {
      throw new Error('generated messages are stale; run npm run asyncapi:generate');
    }
    console.log(`[generate-messages] ${outputFile} is current (${filtered.length} models)`);
  } else {
    fs.writeFileSync(outputFile, output, 'utf-8');
    console.log(`[generate-messages] wrote ${outputFile} (${filtered.length} models)`);
  }
}

function exportify(decl: string): string {
  const trimmed = decl.trimStart();
  if (trimmed.startsWith('export ')) return decl;
  return `export ${trimmed}`;
}

main().catch((err) => {
  console.error('[generate-messages] failed:', err);
  process.exit(1);
});
