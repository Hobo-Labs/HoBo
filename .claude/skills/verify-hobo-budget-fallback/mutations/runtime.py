from pathlib import Path
import shutil, subprocess, tempfile
repo=Path(__file__).resolve().parents[4];base=Path(tempfile.mkdtemp(prefix='hobo-budget-fallback-mutants-'));scratch=base/'hobo'
shutil.copytree(repo/'packages/hobo',scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
(scratch/'node_modules').symlink_to(repo/'packages/hobo/node_modules',target_is_directory=True)
(scratch/'tsconfig.json').unlink()
target=scratch/'src/broker-up-command.ts';original=target.read_text();config=Path(__file__).resolve().parents[1]/'models/vitest.config.mts'
def replace(s,a,b,n=1):
 if s.count(a)!=n: raise Exception(f'expected {n} {a!r}, found {s.count(a)}')
 return s.replace(a,b)
def early(s):
 return replace(s,'\t\t\t\tif (budgetRequiredNow() && (target.kind !== "local" || !yardUp))\n\t\t\t\t\treturn refuseBudgetFallback();\n','')
def fallback(s):
 s=replace(s,'if (budgetRequiredNow()) return refuseBudgetFallback();','',5)
 return replace(s,'if (input.budgetRequired()) return refuseBudgetFallback();','',4)
def start(s):
 a='''\temitProgress(`hobo up: ${placement.message}`);
\tif (!(await input.inputsCurrent()))
\t\treturn refuseChangedInputs("source-after-placement");
\tif (input.budgetRequired()) return refuseBudgetFallback();

\tconst port = await input.allocatePort();
\tif (!(await input.inputsCurrent()))
\t\treturn refuseChangedInputs("source-after-port");
\tif (input.budgetRequired()) return refuseBudgetFallback();'''
 b='''\temitProgress(`hobo up: ${placement.message}`);
\tif (!(await input.inputsCurrent()))
\t\treturn refuseChangedInputs("source-after-placement");

\tconst port = await input.allocatePort();
\tif (!(await input.inputsCurrent()))
\t\treturn refuseChangedInputs("source-after-port");'''
 return replace(s,a,b)
def preview(s):
 a='const definition = await loadBindleDefinition(projectDir);\n\t\t\t\t\tif (!(await localInputsCurrent())) return refuseChangedInputs();\n\t\t\t\t\tif (budgetRequiredNow()) return refuseBudgetFallback();'
 b='const definition = await loadBindleDefinition(projectDir);\n\t\t\t\t\tif (!(await localInputsCurrent())) return refuseChangedInputs();'
 if s.count(a)!=2:raise Exception('expected preview and execution definition guards')
 return s.replace(a,b,1)
cases=[('early',early,'test/hosting-remote-admission.test.ts','cannot bypass a production runtime'),('fallback',fallback,'test/local-budget-fallback.test.ts','refuses budget-required local fallback'),('start',start,'test/local-budget-fallback.test.ts','appears during local placement'),('preview',preview,'test/local-budget-fallback.test.ts','introduced while the local preview loads')]
def run(file,pattern):
 return subprocess.run(['node',str(repo/'node_modules/vitest/vitest.mjs'),'run',file,'--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism','-t',pattern],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=240)
try:
 control=run('test/local-budget-fallback.test.ts','refuses budget-required local fallback')
 if control.returncode!=0 or 'Test Files  1 passed' not in control.stdout:raise Exception(f'control failed: {control.stdout[-3000:]}')
 print('Unmodified control passed',flush=True)
 for name,mutate,file,pattern in cases:
  target.write_text(mutate(original)); result=run(file,pattern)
  if result.returncode==0 or f'FAIL  {file} >' not in result.stdout or 'Failed Suites' in result.stdout:raise Exception(f'{name} expected assertion failure missing: {result.stdout[-3000:]}')
  print(f'Expected real-code failure: {name}',flush=True)
finally:shutil.rmtree(base)
