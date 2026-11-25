/**
 * Anonymous usage telemetry — client module.
 *
 * Telemetry is permanently disabled in this fork. These tests pin that
 * contract: under every input (no config, env forced on, stored config on),
 * getStatus reports disabled and recording/persisting/flushing writes no
 * files, opens no socket, and prints nothing. All seams (dir, fetch, clock,
 * env, stderr) are injected — no network, no real home directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Telemetry, getTelemetry } from '../src/telemetry';

type FetchCall = { url: string; body: Record<string, unknown> };

function mockFetch(calls: FetchCall[], opts: { fail?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.fail) throw new Error('network down');
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
}

describe('Telemetry', () => {
  let dir: string;
  let calls: FetchCall[];
  let stderrLines: string[];
  let nowValue: Date;

  const make = (overrides: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}) =>
    new Telemetry({
      dir,
      fetchImpl: mockFetch(calls),
      now: () => nowValue,
      env: {},
      stderr: (line) => stderrLines.push(line),
      installExitHook: false,
      ...overrides,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-telemetry-'));
    calls = [];
    stderrLines = [];
    nowValue = new Date('2026-06-12T08:00:00.000Z');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('permanently disabled', () => {
    it('reports disabled with no machine id when nothing is configured', () => {
      const t = make();
      expect(t.getStatus()).toMatchObject({ enabled: false, decidedBy: 'disabled', machineId: null });
      expect(t.isEnabled()).toBe(false);
    });

    it('stays disabled even when the env forces it on', () => {
      const t = make({ env: { CODEGRAPH_TELEMETRY: '1' } });
      expect(t.getStatus()).toMatchObject({ enabled: false, decidedBy: 'disabled' });
      expect(t.isEnabled()).toBe(false);
    });

    it('stays disabled even when a stored config enables it', () => {
      const t = make();
      t.setEnabled(true, 'cli');
      expect(t.getStatus()).toMatchObject({ enabled: false, decidedBy: 'disabled', machineId: null });
    });
  });

  describe('records, sends, and writes nothing', () => {
    it('recording then flushing opens no socket and creates no files', async () => {
      const fetchSpy = mockFetch(calls);
      const t = make({ fetchImpl: fetchSpy });
      t.recordUsage('mcp_tool', 'codegraph_explore', true);
      t.recordLifecycle('install', { scope: 'local', kind: 'fresh' });
      t.recordLifecycle('index', { languages: ['go'] });
      t.persistSync();
      await t.flushNow();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(fs.existsSync(t.configPath)).toBe(false);
      expect(fs.existsSync(t.queuePath)).toBe(false);
      expect(stderrLines).toEqual([]);
    });

    it('stays silent across a day boundary (nothing ever becomes sendable)', async () => {
      const t = make();
      t.recordUsage('cli_command', 'query', true);
      t.persistSync();
      nowValue = new Date('2026-06-13T08:00:00.000Z');
      await t.flushNow();
      expect(calls).toHaveLength(0);
      expect(fs.existsSync(t.queuePath)).toBe(false);
    });

    it('the daemon interval starts no sends', () => {
      const fetchSpy = mockFetch(calls);
      const t = make({ fetchImpl: fetchSpy });
      t.startInterval(1000);
      t.recordUsage('mcp_tool', 'codegraph_explore', true);
      expect(fetchSpy).not.toHaveBeenCalled();
      t.stopInterval();
    });

    it('never writes to stdout', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write');
      const t = make({ env: { CODEGRAPH_TELEMETRY_DEBUG: '1' } });
      t.recordUsage('mcp_tool', 'codegraph_explore', true);
      t.recordLifecycle('install', { scope: 'local', kind: 'fresh' });
      await t.flushNow();
      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });
  });

  it('getTelemetry returns a process-wide singleton', () => {
    expect(getTelemetry()).toBe(getTelemetry());
  });
});
