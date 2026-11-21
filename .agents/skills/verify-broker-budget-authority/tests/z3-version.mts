import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureZ3, Z3_VERSION } from './lib/z3-guard.ts';

const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const proofDir = path.join(skillRoot, 'proof');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-z3-guard-'));

function fakeZ3(directory: string, version: string): string {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		path.join(directory, 'z3.py'),
		`def get_version_string():\n    return "${version}"\n`,
	);
	return directory;
}

function baseEnv(fakePath: string): Record<string, string> {
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	delete env.BUDGET_Z3_PYTHONPATH;
	env.PYTHONPATH = fakePath;
	return env;
}

try {
	const matching = fakeZ3(path.join(scratch, 'matching'), Z3_VERSION);
	let installs = 0;
	const matchedEnv = ensureZ3(baseEnv(matching), {
		proofDir,
		scratchDir: path.join(scratch, 'unused'),
		install() {
			installs += 1;
		},
	});
	assert.equal(installs, 0);
	assert.equal(matchedEnv.PYTHONPATH, matching);

	const wrong = fakeZ3(path.join(scratch, 'wrong'), '0.0.0');
	const replacementScratch = path.join(scratch, 'replacement');
	const replacedEnv = ensureZ3(baseEnv(wrong), {
		proofDir,
		scratchDir: replacementScratch,
		install(target) {
			installs += 1;
			fakeZ3(target, Z3_VERSION);
		},
	});
	assert.equal(installs, 1);
	assert.equal(replacedEnv.PYTHONPATH, path.join(replacementScratch, 'python'));
	const afterReplacement = spawnSync(
		'python3',
		['-c', 'import z3; print(z3.get_version_string())'],
		{ env: replacedEnv, encoding: 'utf8' },
	);
	assert.equal(afterReplacement.status, 0);
	assert.equal(afterReplacement.stdout.trim(), Z3_VERSION);

	const failedScratch = path.join(scratch, 'failed');
	assert.throws(
		() =>
			ensureZ3(baseEnv(wrong), {
				proofDir,
				scratchDir: failedScratch,
				install(target) {
					fakeZ3(target, '0.0.1');
				},
			}),
		/expected Z3 4\.15\.4/,
	);
	console.log('Z3 version guard replaced a wrong import and failed closed after a bad replacement');
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
