import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Telemetry } from '../src/telemetry';

describe('telemetry permanently disabled across running instances (#1869)', () => {
  let dir: string;
  let now: Date;
  let sends: any[];
  const make = (env = {}, fetchImpl: typeof fetch = async (_url, init) => {
    sends.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) => new Telemetry({ dir, env, fetchImpl, now: () => now, stderr: () => {}, installExitHook: false });
  const queued = () => fs.readdirSync(dir).filter(n => n.startsWith('telemetry-queue'));
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-telemetry-off-')); now = new Date('2026-06-12T08:00:00Z'); sends = []; });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('stays disabled with no identity whatever setEnabled is asked to store', () => {
    const a = make(); a.setEnabled(true, 'cli');
    expect(a.getStatus()).toMatchObject({ enabled: false, decidedBy: 'disabled', machineId: null });
    make().setEnabled(true, 'cli');
    expect(a.getStatus().machineId).toBeNull();
  });

  it.each(['persist', 'flush'] as const)('records and sends nothing: %s', async action => {
    const a = make(); a.setEnabled(true, 'cli');
    a.recordLifecycle('install', {}); a.recordLifecycle('index', {}); a.recordUsage('mcp_tool', 'codegraph_explore', true);
    if (action === 'persist') a.persistSync(); else await a.flushNow();
    expect(sends).toEqual([]); expect(queued()).toEqual([]);
    await a.flushNow();
    expect(sends).toEqual([]); expect(queued()).toEqual([]);
  });

  it('sends nothing at the completed-day interval', async () => {
    vi.useFakeTimers(); const a = make(); a.setEnabled(true, 'cli'); a.recordUsage('cli_command', 'query', true);
    a.startInterval(); await vi.advanceTimersByTimeAsync(0);
    now = new Date('2026-06-13T08:00:00Z');
    try { await vi.advanceTimersByTimeAsync(6 * 60 * 60_000); expect(sends).toEqual([]); expect(queued()).toEqual([]); }
    finally { a.stopInterval(); }
  });

  it.each(['DO_NOT_TRACK', 'CODEGRAPH_TELEMETRY'])('an explicit environment-on override cannot turn it on: %s', async key => {
    const env: NodeJS.ProcessEnv = { [key]: '1' };
    const a = make(env); a.recordLifecycle('index', {}); a.recordUsage('cli_command', 'query', true);
    await a.flushNow(); a.persistSync(); await a.flushNow();
    expect(a.isEnabled()).toBe(false);
    expect(sends).toEqual([]); expect(queued()).toEqual([]);
  });
});
