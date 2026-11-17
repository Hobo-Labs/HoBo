from pathlib import Path
import re,shutil,subprocess,tempfile
repo=Path(__file__).resolve().parents[4];base=Path(tempfile.mkdtemp(prefix='hobo-embedded-mutants-'));scratch=base/'hobo'
shutil.copytree(repo/'packages/hobo',scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
(scratch/'node_modules').symlink_to(repo/'packages/hobo/node_modules',target_is_directory=True)
(scratch/'tsconfig.json').unlink()
target=scratch/'src/broker-runtime.ts';original=repo/'packages/hobo/src/broker-runtime.ts';config=Path(__file__).resolve().parents[1]/'models/vitest.config.mts'
def remove(s,a,b):
 if s.count(a)!=1:raise Exception(f'expected one {a!r}, found {s.count(a)}')
 return s.replace(a,b)
cases=[('local-scope',lambda s:remove(s,'requiredRuntimes.length !== 0 ||',''),'OCI execution authorized'),('during-approval',lambda s:remove(s,'!runtimeRequirementsCurrent() ||',''),'temporarily during local authorization'),('handoff',lambda s:remove(s,'const runtimeRequirementsChanged = !runtimeRequirementsCurrent();','const runtimeRequirementsChanged = false;'),'during the local authorization handoff')]
def run(pattern):
 return subprocess.run(['node',str(repo/'node_modules/vitest/vitest.mjs'),'run','test/runtime-requirements.test.ts','--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism','-t',pattern],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180)
try:
 c=run('OCI execution authorized')
 if c.returncode!=0 or 'Test Files  1 passed' not in c.stdout:raise Exception(f'control failed: {c.stdout[-2500:]}')
 print('Unmodified control passed',flush=True)
 for name,mutate,pattern in cases:
  target.write_text(mutate(original.read_text()))
  r=run(pattern)
  if r.returncode==0 or 'FAIL  test/runtime-requirements.test.ts >' not in r.stdout or 'Failed Suites' in r.stdout:raise Exception(f'{name} expected test failure missing: {r.stdout[-2500:]}')
  print(f'Expected real-code failure: {name}',flush=True)
finally:shutil.rmtree(base)
