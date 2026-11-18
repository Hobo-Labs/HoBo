"""Exercise site preflight on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-status-site-preflight'
map_block = '''const prepared = options.pages.map((page) => {
\t\tconst slug = slugFor(page);
\t\tif (slugs.has(slug)) {
\t\t\tthrow new TypeError(`duplicate status site slug "${slug}"`);
\t\t}
\t\tslugs.add(slug);
\t\treturn { page, slug };
\t});'''
lazy_block = '''const prepared = (function* () {
\t\tfor (const page of options.pages) {
\t\t\tconst slug = slugFor(page);
\t\t\tif (slugs.has(slug)) {
\t\t\t\tthrow new TypeError(`duplicate status site slug "${slug}"`);
\t\t\t}
\t\t\tslugs.add(slug);
\t\t\tyield { page, slug };
\t\t}
\t})();'''
cases = [
    ('duplicate-guard', 'if (slugs.has(slug)) {', 'if (false) {'),
    ('slug-guard', 'if (!SLUG_PATTERN.test(slug) || slug.includes("..")) {', 'if (false) {'),
    ('early-root', 'const slugs = new Set<string>();', 'mkdirSync(options.rootDir, { recursive: true });\n\tconst slugs = new Set<string>();'),
    ('lazy-validation', map_block, lazy_block),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-status-site-preflight-mutant-') as temp:
        scratch = Path(temp) / 'status-page'
        source = repo / 'packages/status-page'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/site.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'STATUS_SITE_PREFLIGHT_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/site-preflight.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('STATUS_SITE_PREFLIGHT_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
