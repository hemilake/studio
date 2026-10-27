import { describe, expect, it } from 'vitest';

import { pruneRealtimeSupersededByServer, upsertRealtimeMessage } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

const at = (seconds: number) => new Date(Date.parse('2026-10-27T15:00:00.000Z') + seconds * 1000).toISOString();

const row = (fields: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'id' | 'kind'>): NormalizedMessage => ({
  sessionId: 's',
  provider: 'codex',
  timestamp: at(0),
  ...fields,
} as NormalizedMessage);

const prompt = (id: string, seconds: number, content = 'hazlo') => row({ id, kind: 'text', role: 'user', content, timestamp: at(seconds) });
const bash = (id: string, seconds: number, command: string, extra: Partial<NormalizedMessage> = {}) =>
  row({ id, kind: 'tool_use', toolName: 'Bash', toolId: id, toolInput: { command }, timestamp: at(seconds), ...extra });
const result = (toolId: string, seconds: number) => row({ id: `${toolId}_result`, kind: 'tool_result', toolId, content: 'ok', timestamp: at(seconds) });

describe('live rows with the same id', () => {
  it('replace the row they update and keep its start time', () => {
    const started = bash('t1-item_1', 1, 'sed -n 1,40p a', { status: 'in_progress' });
    const completed = bash('t1-item_1', 5, 'sed -n 1,40p a', { status: 'completed' });
    const rows = upsertRealtimeMessage(upsertRealtimeMessage([], started), completed);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'completed', timestamp: at(1) });
  });

  it('append a row with a new id', () => {
    const rows = upsertRealtimeMessage([bash('a', 1, 'ls')], bash('b', 2, 'ls'));
    expect(rows.map((message) => message.id)).toEqual(['a', 'b']);
  });
});

describe('a refresh during a Codex turn', () => {
  it('drops the live commands the rollout already has, and keeps the rest', () => {
    const server = [
      prompt('u1', 0),
      bash('call_a', 1, 'sed -n 1,40p a'),
      bash('call_b', 3, "python3 - <<'PY'\nprint(1)\nPY"),
    ];
    const live = [
      bash('t-item_1', 1, 'sed -n 1,40p a'),
      result('t-item_1', 2),
      bash('t-item_2', 3, "python3 - <<'PY'\nprint(1)\nPY"),
      result('t-item_2', 4),
      bash('t-item_3', 6, 'ls /tmp', { status: 'in_progress' }),
    ];
    expect(pruneRealtimeSupersededByServer(server, live).map((message) => message.id)).toEqual(['t-item_3']);
  });

  it('keeps a repeated command the rollout has only once', () => {
    const server = [prompt('u1', 0), bash('call_a', 1, 'date')];
    const live = [bash('t-item_1', 1, 'date'), bash('t-item_2', 3, 'date')];
    expect(pruneRealtimeSupersededByServer(server, live).map((message) => message.id)).toEqual(['t-item_2']);
  });

  it('does not match a command from an earlier turn', () => {
    const server = [prompt('u1', 0, 'uno'), bash('call_a', 1, 'git status'), prompt('u2', 10, 'dos')];
    const live = [bash('t-item_1', 11, 'git status')];
    expect(pruneRealtimeSupersededByServer(server, live).map((message) => message.id)).toEqual(['t-item_1']);
  });

  it('leaves other providers to the id match', () => {
    const server = [prompt('u1', 0), bash('toolu_1', 1, 'date', { provider: 'claude' })];
    const live = [bash('toolu_2', 1, 'date', { provider: 'claude' })];
    expect(pruneRealtimeSupersededByServer(server, live).map((message) => message.id)).toEqual(['toolu_2']);
  });
});
