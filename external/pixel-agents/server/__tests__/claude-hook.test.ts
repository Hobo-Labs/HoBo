import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let hookDirectory: string;
let hookScript: string;
let tmpBase: string;

function writeServerJson(port: number, token: string): void {
  const dir = path.join(tmpBase, '.pixel-agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'server.json'),
    JSON.stringify({ port, pid: process.pid, token, startedAt: Date.now() }),
  );
}

function writeRegistryEntry(pid: number, port: number, token: string): void {
  const dir = path.join(tmpBase, '.pixel-agents', 'servers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}-${port}.json`),
    JSON.stringify({
      port,
      pid,
      token,
      startedAt: Date.now(),
      servesSpa: false,
      protocol: 1,
    }),
  );
}

function startRecordingServer(): Promise<{ port: number; received: string[]; close: () => void }> {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, received, close: () => server.close() });
    });
  });
}

function runHookScript(
  stdin: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookScript], {
      env: { ...process.env, HOME: tmpBase, USERPROFILE: tmpBase, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('claude-hook.js integration', () => {
  beforeAll(() => {
    hookDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-bundle-'));
    const builder = path.join(__dirname, '../../scripts/build-hooks.cjs');
    const result = spawnSync(process.execPath, [builder, hookDirectory], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`hook build failed: ${result.stderr}`);
    hookScript = path.join(hookDirectory, 'claude-hook.js');
  });

  afterAll(() => {
    if (hookDirectory) fs.rmSync(hookDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-int-'));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('reads stdin and POSTs to server', async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200);
        res.end('ok');
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    writeServerJson(port, 'test-token');

    const event = JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' });
    const { code } = await runHookScript(event);

    server.close();
    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]).session_id).toBe('abc');
  });

  it('exits 0 when server.json is missing', async () => {
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    );
    expect(code).toBe(0);
  });

  it('exits 0 on invalid stdin', async () => {
    writeServerJson(9999, 'tok');
    const { code } = await runHookScript('not json at all!!!');
    expect(code).toBe(0);
  });

  it('exits within 5s when server does not respond', async () => {
    const server = http.createServer(() => {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    writeServerJson((server.address() as { port: number }).port, 'tok');

    const start = Date.now();
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    );
    const elapsed = Date.now() - start;

    server.close();
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(5000);
  });

  it('fans out to every live server in the registry', async () => {
    const a = await startRecordingServer();
    const b = await startRecordingServer();
    writeRegistryEntry(process.pid, a.port, 'token-a');
    writeRegistryEntry(process.pid, b.port, 'token-b');

    const event = JSON.stringify({ session_id: 'fanout', hook_event_name: 'Stop' });
    const { code } = await runHookScript(event);

    a.close();
    b.close();
    expect(code).toBe(0);
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
    expect(JSON.parse(a.received[0]).session_id).toBe('fanout');
    expect(JSON.parse(b.received[0]).session_id).toBe('fanout');
  });

  it('skips a dead-pid registry entry and still delivers to the live one', async () => {
    const live = await startRecordingServer();
    writeRegistryEntry(process.pid, live.port, 'token-live');
    const debugLog = path.join(tmpBase, 'hook-debug.log');
    writeRegistryEntry(999999, 9999, 'token-dead');

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'skip-dead', hook_event_name: 'Stop' }),
      { PIXEL_AGENTS_DEBUG_LOG: debugLog },
    );

    live.close();
    expect(code).toBe(0);
    expect(live.received).toHaveLength(1);
    const debugText = fs.readFileSync(debugLog, 'utf-8');
    expect(debugText).toMatch(/registry-skip reason=dead-pid file=999999-9999\.json pid=999999/);
    expect(debugText).toMatch(new RegExp(`POST event=Stop sid=skip-dea port=${live.port}`));
    expect(debugText).not.toMatch(/POST event=Stop sid=skip-dea port=9999\b/);
  });

  it('skips an invalid live-pid entry and still delivers to the healthy server', async () => {
    const healthy = await startRecordingServer();
    writeRegistryEntry(process.pid, 70_000, 'invalid-port');
    writeRegistryEntry(process.pid, healthy.port, 'healthy-token');
    const debugLog = path.join(tmpBase, 'hook-debug.log');

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'malformed-live', hook_event_name: 'Stop' }),
      { PIXEL_AGENTS_DEBUG_LOG: debugLog },
    );

    healthy.close();
    expect(code).toBe(0);
    expect(healthy.received).toHaveLength(1);
    const debugText = fs.readFileSync(debugLog, 'utf-8');
    expect(debugText).toMatch(
      new RegExp(`registry-skip reason=malformed file=${process.pid}-70000\\.json`),
    );
    expect(debugText).toMatch(new RegExp(`POST event=Stop sid=malforme port=${healthy.port}`));
    expect(debugText).not.toMatch(/POST event=Stop sid=malforme port=70000\b/);
  });

  it('falls back to legacy server.json when the registry directory is empty', async () => {
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents', 'servers'), { recursive: true });
    const legacy = await startRecordingServer();
    writeServerJson(legacy.port, 'legacy-token');

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'legacy-fallback', hook_event_name: 'Stop' }),
    );

    legacy.close();
    expect(code).toBe(0);
    expect(legacy.received).toHaveLength(1);
  });

  it('fans out to multiple unresponsive servers in parallel, not sequentially', async () => {
    const hang = (): Promise<{ port: number; close: () => void }> => {
      const server = http.createServer(() => {});
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve({
            port: (server.address() as { port: number }).port,
            close: () => server.close(),
          });
        });
      });
    };
    const a = await hang();
    const b = await hang();
    writeRegistryEntry(process.pid, a.port, 'token-a');
    writeRegistryEntry(process.pid, b.port, 'token-b');

    const start = Date.now();
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'parallel-timeout', hook_event_name: 'Stop' }),
    );
    const elapsed = Date.now() - start;

    a.close();
    b.close();
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(3500);
  });
});
