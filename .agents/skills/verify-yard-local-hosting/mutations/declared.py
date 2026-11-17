from pathlib import Path
import shutil, subprocess, tempfile
repo=Path(__file__).resolve().parents[4];base=Path(tempfile.mkdtemp(prefix='hobo-declared-mutants-'));scratch=base/'hobo'
shutil.copytree(repo/'packages/hobo',scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
(scratch/'node_modules').symlink_to(repo/'packages/hobo/node_modules',target_is_directory=True)
(scratch/'tsconfig.json').unlink()
target=scratch/'src/broker-runtime.ts';original=target.read_text();config=Path(__file__).resolve().parents[1]/'models/vitest.config.mts'
def replace(s,a,b):
 if s.count(a)!=1:raise Exception(f'expected one {a!r}, found {s.count(a)}')
 return s.replace(a,b)
def drop_known(s):
 return replace(s,'''\t\t\t\t...declaredRuntimeRequirements().filter(
\t\t\t\t\t(runtime): runtime is RequiredRuntimeKind =>
\t\t\t\t\t\truntime === "oci" || runtime === "wasm",
\t\t\t\t),
''','')
def drop_stability(s):
 return replace(s,''') &&
\t\t\t\tcurrentDeclared.length === declaredRuntimes.length &&
\t\t\t\tcurrentDeclared.every(
\t\t\t\t\t(runtime, index) => runtime === declaredRuntimes[index],
\t\t\t\t)''',''')''')
cases=[('known-kinds',drop_known,'checks installation of a declared OCI runtime'),('during-approval',drop_stability,'declared requirements changed temporarily during authorization'),('handoff',drop_stability,'declared requirements changed during the handoff')]
def run(pattern):
 return subprocess.run(['node',str(repo/'node_modules/vitest/vitest.mjs'),'run','test/declared-runtime-binding.test.ts','--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism','-t',pattern],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180)
try:
 control=run('checks installation of a declared OCI runtime')
 if control.returncode!=0 or 'Test Files  1 passed' not in control.stdout:raise Exception(f'control failed: {control.stdout[-3000:]}')
 print('Unmodified control passed',flush=True)
 for name,mutate,pattern in cases:
  target.write_text(mutate(original)); result=run(pattern)
  if result.returncode==0 or 'FAIL  test/declared-runtime-binding.test.ts >' not in result.stdout or 'Failed Suites' in result.stdout:raise Exception(f'{name} expected assertion failure missing: {result.stdout[-3000:]}')
  print(f'Expected real-code failure: {name}',flush=True)
finally:shutil.rmtree(base)
