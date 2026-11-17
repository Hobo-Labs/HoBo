from pathlib import Path
import os, shutil, subprocess, tempfile
repo = Path(os.environ.get('HOBO_LOCAL_WORK_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-local-work-mutants-'))
scratch = base / 'hobo'
shutil.copytree(repo / 'packages/hobo', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/hobo/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
targets = {p: scratch / 'src' / p for p in ['broker-runtime.ts','broker-up-command.ts','local-deployment.ts','local-deployment-worker.ts','local-deployment-fingerprint.ts']}
original = {p: f.read_text() for p, f in targets.items()}
def replace(s, before, after, count=1):
    if s.count(before) != count:
        raise Exception(f'expected {count} occurrences, got {s.count(before)}: {before!r}')
    return s.replace(before, after)
def snapshot(s):
    a='''\t\t\t\tlet localInputsHash: `sha256:${string}` | undefined;
\t\t\t\tif (target.kind === "local") {
\t\t\t\t\ttry {
\t\t\t\t\t\tlocalInputsHash = await fingerprintLocalDeployment(
\t\t\t\t\t\t\tprojectDir,
\t\t\t\t\t\t\thoboHome,
\t\t\t\t\t\t);
\t\t\t\t\t} catch {
\t\t\t\t\t\t/* A local fallback refuses if inputs cannot be read. */
\t\t\t\t\t}
\t\t\t\t}
'''
    s=replace(s,a,'')
    b='\t\t\t\tif (boundary !== undefined) return boundary;\n'
    return replace(s,b,b+a)
def after_approval(s):
    a='\temitProgress(`hobo up: ${placement.message}`);\n\tif (!(await input.inputsCurrent()))\n\t\treturn refuseChangedInputs("source-after-placement");'
    return replace(s,a,'\temitProgress(`hobo up: ${placement.message}`);')
def before_start(s):
    a='\tconst port = await input.allocatePort();\n\tif (!(await input.inputsCurrent()))\n\t\treturn refuseChangedInputs("source-after-port");'
    return replace(s,a,'\tconst port = await input.allocatePort();')
def worker(s):
    a='''\t\tif (
\t\t\t(await fingerprintLocalDeployment(
\t\t\t\texecutionProjectDir,
\t\t\t\tlaunch.hoboHome,
\t\t\t)) !== launch.contentFingerprint
\t\t)
\t\t\tthrow new Error("Approved local deployment snapshot is unavailable");
'''
    return replace(s,a,'')
def execute_snapshot(s):
    return replace(s,'\t\t\tprojectDir: executionProjectDir,','\t\t\tprojectDir: launch.projectDir,')
def content_address(s):
    return replace(s,'\t\tfingerprint.slice("sha256:".length),','\t\t"fixed-snapshot",')
def copy_bytes(s):
    return replace(s,'\t\t\t\t\tawait writeFile(file, bytes, { mode });','\t\t\t\t\tawait writeFile(file, Buffer.from("changed"), { mode });')
def mutable_options(s):
    a='''\t\t\texpectedContentFingerprint !== undefined &&
\t\t\texpectedContentFingerprint !== contentFingerprint'''
    b='''\t\t\tinput.expectedContentFingerprint !== undefined &&
\t\t\tinput.expectedContentFingerprint !== contentFingerprint'''
    return replace(s,a,b)
cases=[
 ('digest','broker-runtime.ts',lambda s:replace(s,'\t\t\toptions.workloadDigest ??\n',''),'binds the supplied project digest'),
 ('snapshot-before-import','broker-up-command.ts',snapshot,'inputs changed while the initial Bindle'),
 ('after-approval','broker-up-command.ts',after_approval,'observed project changes across local placement'),
 ('before-start','broker-up-command.ts',before_start,'project changes while the local port'),
 ('worker','local-deployment-worker.ts',worker,'refuses a corrupted approved snapshot'),
 ('execute-snapshot','local-deployment-worker.ts',execute_snapshot,'serves approved snapshot bytes'),
 ('content-address','local-deployment-fingerprint.ts',content_address,'loads changed source through a new content-addressed'),
 ('copy-bytes','local-deployment-fingerprint.ts',copy_bytes,'loads changed source through a new content-addressed'),
 ('mutable-options','local-deployment.ts',mutable_options,'retains the approved fingerprint'),
]
def run(pattern):
    return subprocess.run(['node',str(repo/'node_modules/vitest/vitest.mjs'),'run','test/local-work-binding.test.ts','--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism','-t',pattern],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=300)
try:
    for name,file,mutate,pattern in cases:
        control=run(pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise Exception(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}',flush=True)
        targets[file].write_text(mutate(original[file]))
        result=run(pattern)
        if result.returncode == 0 or 'FAIL  test/local-work-binding.test.ts >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise Exception(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}',flush=True)
        targets[file].write_text(original[file])
finally:
    shutil.rmtree(base)
