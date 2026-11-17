import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-yard-funded-z3-'));
const env={...process.env};
try {
  if (env.BUDGET_Z3_PYTHONPATH) env.PYTHONPATH=env.BUDGET_Z3_PYTHONPATH;
  const probe=spawnSync('python3',['-c','import z3; assert z3.get_version_string() == "4.15.4"'],{env,stdio:'ignore'});
  if (probe.status !== 0) {
    const target=path.join(scratch,'python');
    const install=spawnSync('python3',['-m','pip','install','--disable-pip-version-check','--no-cache-dir','--no-deps','--target',target,'z3-solver==4.15.4.0'],{env,stdio:'inherit'});
    if (install.error) throw install.error;
    if (install.status !== 0) throw new Error(`Z3 installation failed (${install.status ?? 'no exit status'})`);
    env.PYTHONPATH=target;
  }
  const proof=fileURLToPath(new URL('../proof/admission.py',import.meta.url));
  const result=spawnSync('python3',[proof],{env,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('funded Yard admission proof failed');
  for (const mutation of ['selection','gate_quote','gate_context','hold_quote','hold_context','fresh','final_context','hold']) {
    const mutant=spawnSync('python3',[proof],{env:{...env,YARD_FUNDED_PROOF_MUTATION:mutation},encoding:'utf8'});
    if (mutant.error) throw mutant.error;
    if (mutant.status === 0 || !mutant.stdout.includes('FAIL ')) throw new Error(`proof mutation ${mutation} was not detected`);
    process.stdout.write(`Expected proof counterexample: ${mutation}\n`);
  }
} finally { rmSync(scratch,{recursive:true,force:true}); }
