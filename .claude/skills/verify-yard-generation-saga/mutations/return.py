"""Replay generation result-delivery mutations against real saga tests."""
from pathlib import Path
import os, shutil, subprocess, tempfile
repo=Path(os.environ.get('BROKER_GENERATION_SAGA_VERIFY_REPO') or Path(__file__).resolve().parents[4])
base=Path(tempfile.mkdtemp(prefix='hobo-saga-return-mutants-'));scratch=base/'broker'
shutil.copytree(repo/'packages/broker',scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
(scratch/'node_modules').symlink_to(repo/'packages/broker/node_modules',target_is_directory=True)
(scratch/'tsconfig.json').unlink()
config=Path(__file__).resolve().parents[1]/'models/vitest.config.mts'
source=scratch/'src/yard-placement/generation.ts';original=source.read_text()
def replace(s,a,b,n=1):
 if s.count(a)!=n:raise RuntimeError(f'expected {n} instances of {a!r}, got {s.count(a)}')
 return s.replace(a,b)
def delivery(s,first):
 a='if (!authorized(authorize, deliveryPlan, planDigest))'
 if s.count(a)!=2:raise RuntimeError('expected both delivery checks')
 if first:return s.replace(a,'if (false)',1)
 p=s.rfind(a);return s[:p]+s[p:].replace(a,'if (false)',1)
def retained(s):
 a='attempts.set(key, {\n\t\t\t\t\tplanDigest,\n\t\t\t\t\tplan: recordedPlan,\n\t\t\t\t\tresult: normalized,\n\t\t\t\t});'
 return replace(s,a,'void normalized;')
cases=[
 ('result-check',lambda s:delivery(s,False),'does not return an in-flight result'),
 ('error-check',lambda s:delivery(s,True),'does not return a provider error'),
 ('pending-check',lambda s:replace(s,'if (pending) return await awaitAuthorized(pending);','if (pending) return await pending;'),'does not return an in-flight result'),
 ('owner-check',lambda s:replace(s,'return await awaitAuthorized(operation);','return await operation;'),'does not return an in-flight result'),
 ('delivery-snapshot',lambda s:replace(s,'const deliveryPlan = structuredClone(plan);','const deliveryPlan = plan;'),"inspection plan separate from the provider"),
 ('success-retained',retained,'does not return an in-flight result'),
]
def run(pattern):
 return subprocess.run(['node',str(repo/'node_modules/vitest/vitest.mjs'),'run','test/yard-generation-saga-authorization.test.ts','--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism','-t',pattern],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180)
try:
 for name,mutate,pattern in cases:
  control=run(pattern)
  if control.returncode!=0 or 'Test Files  1 passed' not in control.stdout:raise RuntimeError(f'{name} control failed:\n{control.stdout[-4000:]}')
  print('Control passed:',name,flush=True)
  source.write_text(mutate(original));result=run(pattern)
  if result.returncode==0 or 'FAIL  test/yard-generation-saga-authorization.test.ts >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:raise RuntimeError(f'{name} expected assertion missing:\n{result.stdout[-4000:]}')
  print('Expected real-code failure:',name,flush=True);source.write_text(original)
finally:shutil.rmtree(base)
