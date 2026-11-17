from pathlib import Path
import shutil, subprocess, tempfile
repo=Path(__file__).resolve().parents[4];base=Path(tempfile.mkdtemp(prefix='hobo-bindles-mutants-'));scratch=base/'bindles'
shutil.copytree(repo/'packages/bindles',scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
(scratch/'node_modules').symlink_to(repo/'packages/bindles/node_modules',target_is_directory=True)
(scratch/'tsconfig.json').unlink()
config=Path(__file__).resolve().parents[1]/'models/vitest.config.mts'
targets={name:scratch/'src'/name for name in ('bindle.ts','dependencies.ts')}
original={name:path.read_text() for name,path in targets.items()}
def remove(s,a,b):
 if s.count(a)!=1: raise Exception(f'expected one {a!r}, found {s.count(a)}')
 return s.replace(a,b)
def mutate(name, values):
 b,d=values['bindle.ts'],values['dependencies.ts']
 if name=='drop-oci':
  d=remove(d,'if (record.kind === "container") required.add("oci");','')
  d=remove(d,'if (runtime === "wasm" || runtime === "oci") required.add(runtime);','if (runtime === "wasm") required.add(runtime);')
 if name=='drop-wasm':
  d=remove(d,'if (record.kind === "wasm-component") required.add("wasm");','')
  d=remove(d,'if (runtime === "wasm" || runtime === "oci") required.add(runtime);','if (runtime === "oci") required.add(runtime);')
 if name=='invent-oci':
  b=remove(b,'const runtimes = requiredRuntimesForResources(resources);','const runtimes = [...requiredRuntimesForResources(resources), ...(Object.values(resources).some((r) => r.kind === \"api\" || r.kind === \"web\") ? [\"oci\"] : [])];')
 if name=='invent-wasm':
  b=remove(b,'const runtimes = requiredRuntimesForResources(resources);','const runtimes = [...requiredRuntimesForResources(resources), ...(Object.values(resources).some((r) => r.kind === "api" || r.kind === "web") ? ["wasm"] : [])];')
 if name=='drop-declared':
  b=remove(b,'runtimes: [...requirements.runtimes, ...inferredRequirements.runtimes],','runtimes: [...inferredRequirements.runtimes],')
 if name=='drop-mixed':
  b=remove(b,'runtimes: [...runtimes].sort(),','runtimes: [...runtimes].filter((r) => r !== "wasm" || !runtimes.includes("oci")).sort(),')
 if name=='ignore-annotations':
  d=remove(d,'if (runtime === "wasm" || runtime === "oci") required.add(runtime);','')
 return {'bindle.ts':b,'dependencies.ts':d}
def run():
 return subprocess.run(['node',str(repo/'node_modules/vitest/vitest.mjs'),'run','test/bindle.test.ts','--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180)
try:
 control=run()
 if control.returncode!=0 or 'Test Files  1 passed' not in control.stdout: raise Exception(f'control failed: {control.stdout[-3500:]}')
 print('Unmodified control passed',flush=True)
 for name in ('drop-oci','drop-wasm','invent-oci','invent-wasm','drop-declared','drop-mixed','ignore-annotations'):
  changed=mutate(name,original)
  for file,path in targets.items(): path.write_text(changed[file])
  result=run()
  if result.returncode==0 or 'FAIL  test/bindle.test.ts >' not in result.stdout or 'Failed Suites' in result.stdout: raise Exception(f'{name} expected assertion failure missing: {result.stdout[-3500:]}')
  print(f'Expected real-code failure: {name}',flush=True)
finally: shutil.rmtree(base)
