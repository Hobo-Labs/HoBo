import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-workflow-replay-model-'));
const cases = [
  ['WorkflowReplay', String.raw`IF journaled`, String.raw`IF FALSE`, 'NoJournaledReexecution', 'CONSTANT MaxCalls = 2'],
  ['WorkflowRunIds', String.raw`/\ proposed[w] \notin occupied`, String.raw`/\ TRUE`, 'UniqueRunIds', 'CONSTANTS Workers = {"a", "b"}\n          RunIds = {"one", "two"}'],
  ['WorkflowRunIds', String.raw`/\ proposed[w] \notin occupied`, String.raw`/\ TRUE`, 'NoLegacyReuse', 'CONSTANTS Workers = {"a", "b"}\n          RunIds = {"one", "two"}'],
  ['WorkflowRunIds', String.raw`occupied' = occupied \cup {proposed[w]}`, String.raw`occupied' = occupied`, 'ClaimedIdsAreOccupied', 'CONSTANTS Workers = {"a", "b"}\n          RunIds = {"one", "two"}'],
  ['WorkflowResume', String.raw`Allowed == exists /\ sameInput /\ (~nameRecorded \/ sameWorkflow)`, String.raw`Allowed == TRUE /\ sameInput /\ (~nameRecorded \/ sameWorkflow)`, 'NoEffectFromWrongRun', ''],
  ['WorkflowResume', String.raw`Allowed == exists /\ sameInput /\ (~nameRecorded \/ sameWorkflow)`, String.raw`Allowed == exists /\ TRUE /\ (~nameRecorded \/ sameWorkflow)`, 'NoEffectFromWrongRun', ''],
  ['WorkflowResume', String.raw`Allowed == exists /\ sameInput /\ (~nameRecorded \/ sameWorkflow)`, String.raw`Allowed == exists /\ sameInput /\ TRUE`, 'NoEffectFromWrongRun', ''],
  ['WorkflowResume', String.raw`(IF seedRecorded THEN storedSeed ELSE engineSeed)`, String.raw`engineSeed`, 'RecordedSeedIsPreserved', ''],
  ['WorkflowTerminal', String.raw`Run == /\ phase = "running"`, String.raw`Run == /\ phase \in {"running", "completed", "failed"}`, 'NoTerminalRerun', ''],
  ['WorkflowTerminal', String.raw`/\ resumes' = resumes + 1 /\ returnedOutcome' = savedOutcome
          /\ UNCHANGED <<phase, calls, terminalCalls, savedOutcome>>`, String.raw`/\ resumes' = resumes + 1 /\ returnedOutcome' = savedOutcome /\ terminalFacts' = terminalFacts + 1
          /\ UNCHANGED <<phase, calls, terminalCalls, savedOutcome>>`, 'NoDuplicateTerminalFact', ''],
  ['WorkflowTerminal', String.raw`returnedOutcome' = savedOutcome`, String.raw`returnedOutcome' = "none"`, 'ResumeReturnsRecorded', ''],
  ['WorkflowStepJournal', String.raw`FinishFailed == /\ phase = "finishing-failure"
                /\ phase' = IF EnforceConsumption /\ consumed <= maxIndex`, String.raw`FinishFailed == /\ phase = "finishing-failure"
                /\ phase' = IF FALSE /\ consumed <= maxIndex`, 'NoUnconsumedTerminal', 'CONSTANT EnforceConsumption = TRUE'],
  ['WorkflowStepJournal', String.raw`FinishSucceeded == /\ phase = "finishing-success"
                   /\ phase' = IF EnforceConsumption /\ consumed <= maxIndex`, String.raw`FinishSucceeded == /\ phase = "finishing-success"
                   /\ phase' = IF FALSE /\ consumed <= maxIndex`, 'NoUnconsumedTerminal', 'CONSTANT EnforceConsumption = TRUE'],
] as const;
try {
  for (const [model, before, after, invariant, constants] of cases) {
    const original = readFileSync(fileURLToPath(new URL(`../models/${model}.tla`, import.meta.url)), 'utf8');
    if (original.split(before).length !== 2) throw new Error(`${model}/${invariant}: mutation site is not unique`);
    writeFileSync(path.join(scratch, `${model}.tla`), original.replace(before, after));
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `${constants}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', `${model}.tla`], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) throw new Error(`${model}/${invariant}: expected counterexample\n${output}`);
    console.log(`Expected counterexample: ${model}/${invariant}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
