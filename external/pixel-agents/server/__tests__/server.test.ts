import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;
let serverJsonDir: string;
let serverJsonPath: string;
let registryDir: string;

function registryFiles(): string[] {
  try {
    return fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');

async function postHook(
  port: number,
  token: string,
  body: string,
  providerId = 'claude',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/hooks/${providerId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

describe('PixelAgentsServer', () => {
  let server: InstanceType<typeof PixelAgentsServer>;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-server-test-'));
    serverJsonDir = path.join(tmpBase, '.pixel-agents');
    serverJsonPath = path.join(serverJsonDir, 'server.json');
    registryDir = path.join(serverJsonDir, 'servers');
    fs.mkdirSync(serverJsonDir, { recursive: true });
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
    }
  });

  it('starts and returns config with port, token, pid', async () => {
    const config = await server.start();
    expect(config.port).toBeGreaterThan(0);
    expect(config.token).toBeTruthy();
    expect(config.pid).toBe(process.pid);
    expect(config.startedAt).toBeGreaterThan(0);
  });

  it('health endpoint returns 200 with uptime', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number; pid: number };
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.pid).toBe(process.pid);
  });

  it('hook endpoint returns 401 without auth', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/claude`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('hook endpoint returns 200 with valid auth', async () => {
    const config = await server.start();
    const res = await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'test', hook_event_name: 'Stop' }),
    );
    expect(res.status).toBe(200);
  });

  it('hook callback fires on valid event', async () => {
    const config = await server.start();
    const received: Array<{ providerId: string; event: Record<string, unknown> }> = [];
    server.onHookEvent((providerId: string, event: Record<string, unknown>) => {
      received.push({ providerId, event });
    });

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].providerId).toBe('claude');
    expect(received[0].event.session_id).toBe('abc');
    expect(received[0].event.hook_event_name).toBe('Stop');
  });

  it('hook endpoint returns 413 for oversized body', async () => {
    const config = await server.start();
    const bigBody = 'x'.repeat(70_000);
    const res = await postHook(config.port, config.token, bigBody);
    expect(res.status).toBe(413);
  });

  it('hook endpoint returns 400 for invalid JSON', async () => {
    const config = await server.start();
    const res = await postHook(config.port, config.token, 'not json {{{');
    expect(res.status).toBe(400);
  });

  it('hook endpoint returns 400 for missing provider ID', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('writes server.json with port, pid, token', async () => {
    const config = await server.start();
    const json = JSON.parse(fs.readFileSync(serverJsonPath, 'utf-8'));
    expect(json.port).toBe(config.port);
    expect(json.pid).toBe(process.pid);
    expect(json.token).toBe(config.token);
  });

  it('writes a registry entry with port, pid, servesSpa, protocol', async () => {
    const config = await server.start();
    const files = registryFiles();
    expect(files).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(registryDir, files[0]), 'utf-8'));
    expect(entry.port).toBe(config.port);
    expect(entry.pid).toBe(process.pid);
    expect(entry.token).toBe(config.token);
    expect(entry.servesSpa).toBe(false);
    expect(typeof entry.protocol).toBe('number');
  });

  it('second embedded instance reuses an existing embedded server', async () => {
    const config1 = await server.start({ embedded: true });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: true });
    expect(config2.port).toBe(config1.port);
    expect(config2.pid).toBe(config1.pid);
    expect(registryFiles()).toHaveLength(1);
    server2.stop();
  });

  it('second standalone instance reuses an existing standalone server', async () => {
    const config1 = await server.start({ embedded: false });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: false });
    expect(config2.port).toBe(config1.port);
    expect(registryFiles()).toHaveLength(1);
    server2.stop();
  });

  it('standalone does not reuse an existing embedded server; starts its own', async () => {
    const config1 = await server.start({ embedded: true });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: false });
    expect(config2.port).not.toBe(config1.port);
    expect(registryFiles()).toHaveLength(2);
    server2.stop();
  });

  it('embedded does not reuse an existing standalone server; starts its own', async () => {
    const config1 = await server.start({ embedded: false });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: true });
    expect(config2.port).not.toBe(config1.port);
    expect(registryFiles()).toHaveLength(2);
    server2.stop();
  });

  it('embedded and standalone servers coexist as two live registry entries', async () => {
    const embeddedConfig = await server.start({ embedded: true });
    const standalone = new PixelAgentsServer();
    const standaloneConfig = await standalone.start({ embedded: false });

    expect(standaloneConfig.port).not.toBe(embeddedConfig.port);
    expect(standaloneConfig.token).not.toBe(embeddedConfig.token);
    const files = registryFiles();
    expect(files).toHaveLength(2);
    const entries = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(registryDir, f), 'utf-8')),
    );
    expect(entries.some((e) => e.servesSpa === false && e.port === embeddedConfig.port)).toBe(true);
    expect(entries.some((e) => e.servesSpa === true && e.port === standaloneConfig.port)).toBe(
      true,
    );

    standalone.stop();
  });

  it('prunes dead-pid registry entries on start instead of reusing them', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const staleFile = path.join(registryDir, '999999-9999.json');
    fs.writeFileSync(
      staleFile,
      JSON.stringify({
        port: 9999,
        pid: 999999,
        token: 'stale',
        startedAt: 0,
        servesSpa: false,
        protocol: 1,
      }),
    );

    const config = await server.start({ embedded: true });

    expect(fs.existsSync(staleFile)).toBe(false);
    expect(config.port).not.toBe(9999);
    expect(registryFiles()).toHaveLength(1);
  });

  it('prunes a structurally invalid live-pid entry instead of reusing it', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const malformedFile = path.join(registryDir, `${process.pid}-70000.json`);
    fs.writeFileSync(
      malformedFile,
      JSON.stringify({
        port: 70_000,
        pid: process.pid,
        token: 'invalid-port',
        startedAt: Date.now(),
        servesSpa: false,
        protocol: 1,
      }),
    );

    const config = await server.start({ embedded: true });

    expect(config.port).not.toBe(70_000);
    expect(fs.existsSync(malformedFile)).toBe(false);
    expect(registryFiles()).toHaveLength(1);
  });

  it('deletes server.json on stop', async () => {
    await server.start();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
    server.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(false);
  });

  it('does not delete server.json if PID mismatch', async () => {
    fs.writeFileSync(
      serverJsonPath,
      JSON.stringify({ port: 9999, pid: 999999, token: 'fake', startedAt: 0 }),
    );
    const server2 = new PixelAgentsServer();
    server2.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
  });

  it('deletes only its own registry entry on stop, preserving a coexisting server', async () => {
    const embeddedConfig = await server.start({ embedded: true });
    const standalone = new PixelAgentsServer();
    const standaloneConfig = await standalone.start({ embedded: false });
    expect(registryFiles()).toHaveLength(2);

    standalone.stop();

    const remaining = registryFiles().map(
      (f) => JSON.parse(fs.readFileSync(path.join(registryDir, f), 'utf-8')) as { port: number },
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].port).toBe(embeddedConfig.port);
    expect(remaining.some((e) => e.port === standaloneConfig.port)).toBe(false);
  });

  it('unknown route returns 404', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/random/path`);
    expect(res.status).toBe(404);
  });

  it('hook callback does not fire for events without session_id', async () => {
    const config = await server.start();
    const received: unknown[] = [];
    server.onHookEvent((_pid: string, event: Record<string, unknown>) => received.push(event));

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ hook_event_name: 'Stop' }),
    );

    expect(received).toHaveLength(0);
  });
});
