import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ActivitySegment from '@/modules/chat/transcript/ActivitySegment';
import { describeStep, humanizeName, summarizeSteps } from '@/modules/chat/utils/activityNaming';
import { buildTranscript, type ActivitySegment as ActivitySegmentModel } from '@/modules/chat/utils/turnSegments';
import { formatToolDisplayName } from '@/modules/chat/tools/configs/toolConfigs';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { ChatMessage, ToolResult } from '@/shared/types';

const createDiff = createCachedDiffCalculator();
const HEMI = 'mcp__plugin_hemilake_hemilake__';

let clock = Date.parse('2026-10-08T08:25:00.000Z');
const tick = (ms = 1000) => new Date((clock += ms)).toISOString();

const user = (content: string): ChatMessage => ({ type: 'user', content, timestamp: tick() });
const text = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ type: 'assistant', content, timestamp: tick(), ...extra });
let ids = 0;
const tool = (toolName: string, input: Record<string, unknown>, result?: string | ToolResult | null): ChatMessage => {
  const timestamp = tick();
  const toolResult: ToolResult | null = result === undefined || result === null
    ? null
    : typeof result === 'string'
      ? { content: result, isError: false, timestamp: tick(700) }
      : { timestamp: tick(700), ...result };
  return {
    type: 'assistant',
    content: '',
    timestamp,
    isToolUse: true,
    toolName,
    toolId: `toolu_${(ids += 1)}`,
    toolInput: JSON.stringify(input, null, 2),
    toolResult,
  };
};

const segmentsOf = (messages: ChatMessage[], opts?: { isProcessing?: boolean }) =>
  buildTranscript(messages, opts).items.filter((item): item is ActivitySegmentModel => item.kind === 'activity');

const renderSegment = (segment: ActivitySegmentModel, props: Partial<React.ComponentProps<typeof ActivitySegment>> = {}) =>
  renderToStaticMarkup(React.createElement(ActivitySegment, { segment, onToggle: () => {}, createDiff, ...props }));

const recallAnswer = JSON.stringify({
  query: 'masiva prepago',
  facts: [
    { fact: 'BSS calls Provi through the network API gateway over HTTPS', valid_at: '2026-10-02T08:00:00Z', lake: { id: 'think' } },
    { fact: 'A prepaid bonus incident on 2 Oct was fixed by a TCP change', valid_at: '2026-10-02T09:00:00Z', lake: { id: 'think' } },
  ],
  people: [{ name: 'Mario Bodega' }, { name: 'Pedro Sanz' }],
});

describe('segmenting a turn', () => {
  it('splits text / tool / tool / text / tool into text and activity segments', () => {
    const { items } = buildTranscript([
      user('investiga'),
      text('Miro primero.'),
      tool('Bash', { command: 'ls', description: 'List files' }, 'a\nb'),
      tool(`${HEMI}recall`, { query: 'masiva' }, recallAnswer),
      text('Ahora el destino.'),
      tool('Read', { file_path: '/tmp/a.ts' }, 'x'),
    ]);

    expect(items.map((item) => (item.kind === 'message' ? `${item.message.type}` : item.kind))).toEqual([
      'user', 'assistant', 'activity', 'assistant', 'activity', 'turn-footer',
    ]);
    const [first, second] = items.filter((item): item is ActivitySegmentModel => item.kind === 'activity');
    expect(first.steps).toHaveLength(2);
    expect(second.steps).toHaveLength(1);
  });

  it('merges call and result into one row, and never draws an Output row', () => {
    const [segment] = segmentsOf([tool(`${HEMI}slack_search_messages`, { query: 'provi' }, JSON.stringify({ messages: [{}, {}, {}], count: 3 }))]);
    const markup = renderSegment(segment, { open: true });

    expect(markup).toContain('Searched Slack');
    expect(markup).toContain('3 messages');
    expect(markup).not.toContain('Output');
  });

  it('keeps a footer id when older turns are prepended (fork: no remounts on "load earlier")', () => {
    const older = [user('first'), tool('Bash', { command: 'ls' }, 'a'), text('ok')];
    const newer = [user('second'), tool('Bash', { command: 'pwd' }, 'b'), text('done')];
    const footerIds = (messages: ChatMessage[]) =>
      buildTranscript(messages).items.filter((item) => item.kind === 'turn-footer').map((item) => item.id);

    const before = footerIds(newer);
    const after = footerIds([...older, ...newer]);
    expect(after).toHaveLength(2);
    expect(after[1]).toBe(before[0]);
  });

  it('counts the turn in its footer once the turn is over', () => {
    const { items } = buildTranscript([user('go'), tool('Bash', { command: 'ls' }, 'a'), tool('Bash', { command: 'pwd' }, 'b'), text('done')]);
    const footer = items[items.length - 1];
    expect(footer.kind).toBe('turn-footer');
    expect(footer.kind === 'turn-footer' && footer.steps).toBe(2);
  });
});

describe('naming', () => {
  const name = (toolName: string, input: Record<string, unknown>, content?: string, isError = false) =>
    describeStep(toolName, input, content === undefined ? null : { content, isError });

  it('names Hemilake memory tools with the lake symbol', () => {
    const recall = name(`${HEMI}recall`, { query: 'masiva' }, recallAnswer);
    expect(recall).toMatchObject({ verb: 'Recalled', icon: 'lake', result: '2 facts · 2 people', arg: 'masiva' });
    expect(recall.facts[0]).toEqual({ text: 'BSS calls Provi through the network API gateway over HTTPS', meta: 'valid since 2 Oct' });

    expect(name(`${HEMI}search_memory_facts`, { query: 'q' }, JSON.stringify({ result: { facts: [{}, {}, {}, {}, {}] } })))
      .toMatchObject({ verb: 'Searched facts', icon: 'lake', result: '5 facts' });
    expect(name(`${HEMI}search_nodes`, { query: 'q' }, JSON.stringify({ result: { nodes: [{ labels: ['Person'] }, { labels: ['Entity'] }] } })))
      .toMatchObject({ verb: 'Looked up', result: '1 person · 1 thing' });
    expect(name(`${HEMI}get_episode`, { uuid: 'x' }, JSON.stringify({ result: { source: 'teams', valid_at: '2026-10-02T08:00:00Z' } })))
      .toMatchObject({ verb: 'Opened source', result: 'teams · 2 Oct' });
    expect(name(`${HEMI}add_memory`, { name: 'x' }, JSON.stringify({ result: { message: 'queued', uuid: 'u' } })))
      .toMatchObject({ verb: 'Saved to your lake', result: 'queued' });
  });

  it('names channel tools by what they did, and says "via Hemilake" only for Hemilake', () => {
    const history = name(`${HEMI}slack_get_history`, { channel: 'C123' }, JSON.stringify({ channel: 'C123', messages: new Array(50).fill({}), count: 50 }));
    expect(history).toMatchObject({ verb: 'Read channel', icon: 'slack', result: '50 messages', viaHemilake: true });
    expect(name(`${HEMI}slack_get_thread`, { channel: 'C1', thread_ts: '1.2' }, JSON.stringify({ messages: new Array(15).fill({}) })))
      .toMatchObject({ verb: 'Read thread', result: '14 replies' });
    expect(name(`${HEMI}o365_mail_search`, { query: 'x' }, JSON.stringify({ messages: [{}, {}], count: 2 })))
      .toMatchObject({ verb: 'Searched mail', icon: 'mail' });
    expect(name(`${HEMI}gmail_get_message`, { id: 'x' }, '{}')).toMatchObject({ verb: 'Read mail', icon: 'mail' });
    expect(name(`${HEMI}teams_get_chat_messages`, { chat_id: 'x' }, JSON.stringify({ messages: [{}] })))
      .toMatchObject({ verb: 'Read Teams', icon: 'teams', result: '1 message' });
    expect(name(`${HEMI}gcal_list_events`, { start: 'a', end: 'b' }, JSON.stringify({ events: [{}, {}, {}] })))
      .toMatchObject({ verb: 'Read calendar', icon: 'calendar', result: '3 events' });
    expect(name('mcp__slack__search_messages', { query: 'x' }, JSON.stringify({ messages: [] })))
      .toMatchObject({ verb: 'Searched Slack', viaHemilake: false });
  });

  it('names Bash by its description, with lines and a non-zero exit', () => {
    expect(name('Bash', { command: 'dig +short apigw.mm-red.net', description: 'Resolving apigw.mm-red.net' }, '10.1.2.3\n10.1.2.4'))
      .toMatchObject({ verb: 'Resolving apigw.mm-red.net', icon: 'bash', arg: 'dig +short apigw.mm-red.net', result: '2 lines' });
    expect(name('Bash', { command: 'kubectl get pods -n x' }, 'a')).toMatchObject({ verb: 'kubectl' });
    expect(name('Bash', { command: 'false' }, 'Exit code 1\nboom', true))
      .toMatchObject({ result: 'exit 1', resultTone: 'bad', errorLine: 'boom' });
  });

  it('names files and skills', () => {
    expect(name('Read', { file_path: '/repo/src/a.ts' }, 'l1\nl2\nl3')).toMatchObject({ verb: 'Read', arg: '/repo/src/a.ts', result: '3 lines' });
    expect(name('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, 'ok')).toMatchObject({ verb: 'Edited', icon: 'file' });
    expect(name('Write', { file_path: '/repo/b.ts', content: 'x\ny' }, 'ok')).toMatchObject({ verb: 'Wrote file', result: '2 lines' });
    expect(name('Skill', { skill: 'no-ai-slop' }, 'Launching skill')).toMatchObject({ verb: 'Used skill “no-ai-slop”', icon: 'skill' });
  });

  it('humanises unknown MCP tools and never shows the plugin suffix', () => {
    const unknown = name('mcp__plugin_hemilake_hemilake__orange_parking_status', {}, '{}');
    expect(unknown.verb).toBe('Orange parking status');
    expect(name('mcp__linear__save_issue', { title: 'x' }, '{}')).toMatchObject({ verb: 'Save issue', icon: 'tool' });
    expect(humanizeName('foo_bar_baz')).toBe('Foo bar baz');
    expect(formatToolDisplayName(`${HEMI}recall`)).toBe('Recall');

    const [segment] = segmentsOf([
      tool(`${HEMI}recall`, { query: 'q' }, recallAnswer),
      tool(`${HEMI}orange_parking_status`, {}, '{}'),
    ]);
    const markup = renderSegment(segment, { open: true });
    expect(markup).not.toContain('plugin_hemilake');
    expect(markup).not.toContain('mcp__');
  });

  it('writes the folded line in words: one phrase per kind, counts for repeats', () => {
    const calls = [
      ['Bash', { command: 'cat notes.md', description: 'Read incident notes' }],
      [`${HEMI}recall`, { query: 'q' }],
      [`${HEMI}slack_search_messages`, { query: 'q' }],
      [`${HEMI}slack_get_history`, { channel: 'C1' }],
      ['Bash', { command: 'date' }],
      [`${HEMI}search_memory_facts`, { query: 'q' }],
      ['Bash', { command: 'python3 q.py' }],
    ] as const;
    const summary = summarizeSteps(calls.map(([toolName, input]) => ({ input, description: describeStep(toolName, input, { content: '{}', isError: false }) })));
    expect(summary).toBe('Ran 3 commands, recalled from your lake, read Slack');
  });
});

describe('repeats', () => {
  it('collapses identical consecutive calls of any tool into one row with ×N', () => {
    const [segment] = segmentsOf([
      tool(`${HEMI}recall`, { query: 'a' }, recallAnswer),
      tool(`${HEMI}recall`, { query: 'b' }, recallAnswer),
      tool('Bash', { command: 'date -d @1', description: 'Converted times to Madrid' }, '1'),
      tool('Bash', { command: 'date -d @2', description: 'Converted times to Madrid' }, '2'),
      tool('Bash', { command: 'ls', description: 'Listed files' }, '2'),
    ]);

    expect(segment.steps.map((step) => [step.description.verb, step.calls.length])).toEqual([
      ['Recalled', 2],
      ['Converted times to Madrid', 2],
      ['Listed files', 1],
    ]);
    expect(renderSegment(segment, { open: true })).toContain('×2');
  });

  it('never folds a failed call into its neighbours', () => {
    const [segment] = segmentsOf([
      tool('Bash', { command: 'x', description: 'Probe' }, 'ok'),
      tool('Bash', { command: 'x', description: 'Probe' }, { content: 'Exit code 2\nno route', isError: true }),
    ]);
    expect(segment.steps).toHaveLength(2);
  });
});

describe('errors', () => {
  it('opens a segment with a failed step and shows its error line', () => {
    const [segment] = segmentsOf([
      tool('Bash', { command: 'ok', description: 'Fine' }, 'ok'),
      tool('Bash', { command: 'curl https://apigw', description: 'Called the gateway' }, { content: 'Exit code 7\ncurl: (7) Failed to connect', isError: true }),
    ]);
    expect(segment.hasError).toBe(true);

    const markup = renderSegment(segment);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('exit 7');
    expect(markup).toContain('curl: (7) Failed to connect');
    expect(markup).toContain('text-destructive');
  });

  it('keeps a segment without errors folded', () => {
    const [segment] = segmentsOf([tool('Bash', { command: 'ok', description: 'Fine' }, 'ok')]);
    expect(renderSegment(segment)).toContain('aria-expanded="false"');
  });
});

describe('the live line', () => {
  const turn = [
    user('investiga'),
    tool('Bash', { command: 'cat notes', description: 'Read incident notes' }, 'a'),
    tool(`${HEMI}recall`, { query: 'masiva' }, recallAnswer),
    text('El destino es apigw.'),
    tool('Bash', { command: 'dig apigw', description: 'Resolving apigw.mm-red.net' }, 'ok'),
  ];

  /** Every point of the turn as it streams: each step running, then done. */
  const pointsInTime = (): ChatMessage[][] => {
    const points: ChatMessage[][] = [];
    for (let end = 1; end <= turn.length; end += 1) {
      const last = turn[end - 1];
      if (last.isToolUse) points.push([...turn.slice(0, end - 1), { ...last, toolResult: null }]);
      points.push(turn.slice(0, end));
    }
    return points;
  };

  it('is exactly one while the turn runs, at every point', () => {
    for (const messages of pointsInTime()) {
      const { items, live } = buildTranscript(messages, { isProcessing: true });
      expect(live).not.toBeNull();
      const segments = items.filter((item): item is ActivitySegmentModel => item.kind === 'activity');
      const owners = segments.filter((segment) => segment.id === live!.segmentId);
      // Either the trailing segment draws it, or the pane draws it alone.
      expect(owners.length).toBeLessThanOrEqual(1);
      const markups = segments.map((segment) => renderSegment(segment, { live: segment.id === live!.segmentId ? live : null }));
      const drawnBySegments = markups.join('').split('data-activity-live').length - 1;
      expect(drawnBySegments + (live!.segmentId ? 0 : 1)).toBe(1);
      expect(items.some((item) => item.kind === 'turn-footer')).toBe(false);
    }
  });

  it('names the running step, with the lake ping for Hemilake', () => {
    const { items, live } = buildTranscript([user('x'), tool(`${HEMI}recall`, { query: 'masiva' }, null)], { isProcessing: true });
    expect(live?.call?.description.verb).toBe('Recalled');
    const segment = items.find((item): item is ActivitySegmentModel => item.kind === 'activity')!;
    const markup = renderSegment(segment, { live });
    expect(markup).toContain('hemi-activity-ping');
    expect(markup).toContain('hemi-activity-sweep');
  });

  it('is gone once the turn is over, and unfinished calls read as interrupted', () => {
    const messages = [user('x'), tool('Bash', { command: 'sleep 99', description: 'Waiting' }, null)];
    const { live, items } = buildTranscript(messages, { isProcessing: false });
    expect(live).toBeNull();
    const segment = items.find((item): item is ActivitySegmentModel => item.kind === 'activity')!;
    expect(segment.running).toHaveLength(0);
    expect(segment.steps[0].status).toBe('interrupted');
    expect(renderSegment(segment, { open: true })).not.toContain('data-activity-live');
  });

  it('holds the segment summary until the segment is done', () => {
    const running = buildTranscript(turn.slice(0, 3), { isProcessing: true });
    const trailing = running.items.find((item): item is ActivitySegmentModel => item.kind === 'activity')!;
    expect(trailing.isTrailing).toBe(true);
    const markup = renderSegment(trailing, { live: running.live });
    expect(markup).toContain('2 done so far');
    expect(markup).not.toContain('recalled from your lake');

    const finished = buildTranscript(turn.slice(0, 4), { isProcessing: true });
    const done = finished.items.find((item): item is ActivitySegmentModel => item.kind === 'activity')!;
    expect(done.isTrailing).toBe(false);
    expect(renderSegment(done)).toContain('Ran a command, recalled from your lake');
  });
});

describe('reduced motion', () => {
  it('turns off the sweep, the ping and the rise', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const block = css.slice(css.indexOf('.hemi-activity-sweep {'));
    const reduced = block.slice(block.indexOf('@media (prefers-reduced-motion: reduce)'));
    const body = reduced.slice(0, reduced.indexOf('\n  }\n') + 4);
    expect(body).toMatch(/\.hemi-activity-sweep \{[^}]*animation: none/);
    expect(body).toMatch(/\.hemi-activity-ping \{[^}]*display: none/);
    expect(body).toMatch(/\.hemi-activity-rise \{[^}]*animation: none|\.hemi-activity-rise[^{]*\{[^}]*animation: none/);
  });
});
