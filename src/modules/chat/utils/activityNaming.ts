/**
 * Fork (Hemilake Studio activity): how each tool call is named in the chat.
 *
 * One table for the transcript and the export, so a tool reads the same in both:
 * the verb a step row shows, the argument beside it, a short summary of what came
 * back, the icon kind, and the phrase the folded activity line uses for it. Names
 * are words, never tool ids: `mcp__plugin_hemilake_hemilake__recall` is
 * "Recalled" with the lake symbol, a Bash call is its own description.
 */
import type { ToolResult } from '@/shared/types';

/** Which icon a step wears. `lake` is the Hemilake symbol. */
export type StepIconKind =
  | 'lake'
  | 'slack'
  | 'mail'
  | 'teams'
  | 'calendar'
  | 'chat'
  | 'docs'
  | 'bash'
  | 'file'
  | 'search'
  | 'web'
  | 'skill'
  | 'plan'
  | 'tool';

export type ResultTone = 'ok' | 'bad' | 'muted';

/** One fact of a lake answer, shown as a line in the opened row. */
export type StepFact = {
  text: string;
  meta: string;
};

export type StepDescription = {
  toolName: string;
  icon: StepIconKind;
  /** Bold label of the row: "Recalled", "Read thread", a Bash description. */
  verb: string;
  /** The most telling input, one line: the query, the path, the command. */
  arg: string;
  /** What came back, short: "8 facts · 2 people", "67 lines", "exit 1". Null while running. */
  result: string | null;
  resultTone: ResultTone;
  /** The first line of an error, shown under the row in the bad tone. */
  errorLine: string | null;
  /** Hemilake channel tools say so inside the opened row. */
  viaHemilake: boolean;
  /** Lake answers that carry facts list them in the opened row. */
  facts: StepFact[];
  /** Consecutive steps with the same key fold into one row with ×N. */
  collapseKey: string;
  /** The phrase of the folded line this step contributes to. */
  phrase: StepPhrase;
};

/** A phrase of the folded line: steps with the same id share one phrase. */
export type StepPhrase = {
  id: string;
  /** Lowercase phrase; `{n}` is replaced by the count when `plural` is used. */
  one: string;
  plural?: string;
  /** Count distinct values (file paths) instead of calls. */
  countBy?: string;
};

type McpName = { server: string; tool: string };

/** Splits `mcp__<server>__<tool>`; null for a built-in tool. */
export function splitMcpName(toolName: string): McpName | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? { server: match[1], tool: match[2] } : null;
}

/** `foo_bar_baz` and `fooBarBaz` become "Foo bar baz". */
export function humanizeName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** Hemilake's MCP server, under its plugin, standalone or by its old name. */
function isHemilakeServer(server: string): boolean {
  return /hemilake|hemisphere/i.test(server);
}

function oneLine(value: string, max = 160): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many ?? `${one}s`}`;
}

/** The text of a tool result, whatever shape the provider stored. */
export function resultText(result: ToolResult | null | undefined): string {
  if (!result) return '';
  const { content } = result;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : str(asRecord(part).text)))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Hemilake's MCP answers wrap some payloads in `{result: …}`. */
function unwrap(payload: unknown): unknown {
  const record = asRecord(payload);
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'result') return record.result;
  if ('result' in record && typeof record.result === 'object' && record.result !== null && !('query' in record)) {
    return record.result;
  }
  return payload;
}

function countLines(text: string): number {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed ? trimmed.split('\n').length : 0;
}

function shortDate(iso: unknown): string {
  const value = str(iso);
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Array keys a JSON answer counts by, most telling first, with the word for one. */
const COUNTED_KEYS: Array<[string, string, string?]> = [
  ['messages', 'message'],
  ['facts', 'fact'],
  ['events', 'event'],
  ['hits', 'result'],
  ['files', 'file'],
  ['pages', 'page'],
  ['episodes', 'source'],
  ['passages', 'passage'],
  ['nodes', 'thing'],
  ['chats', 'chat'],
  ['conversations', 'conversation'],
  ['results', 'result'],
  ['items', 'item'],
  ['issues', 'issue'],
  ['entities', 'entity', 'entities'],
];

function countJsonAnswer(payload: unknown): string | null {
  if (Array.isArray(payload)) return plural(payload.length, 'item');
  const record = asRecord(payload);
  for (const [key, one, many] of COUNTED_KEYS) {
    if (Array.isArray(record[key])) return plural((record[key] as unknown[]).length, one, many);
  }
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      const word = humanizeName(key).toLowerCase();
      return plural(value.length, word.endsWith('s') ? word.slice(0, -1) : word, word);
    }
  }
  return null;
}

/** The error a JSON answer reports without failing the call (`{"error": "not_found"}`). */
function jsonError(payload: unknown): string | null {
  const record = asRecord(payload);
  if (typeof record.error === 'string' && record.error) {
    const detail = str(record.detail) || str(record.message);
    return detail ? `${record.error}: ${oneLine(detail, 100)}` : record.error;
  }
  return null;
}

function factsOf(list: unknown): StepFact[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 12).flatMap((item) => {
    const fact = asRecord(item);
    const text = str(fact.fact);
    if (!text) return [];
    const since = shortDate(fact.valid_at);
    const until = shortDate(fact.invalid_at);
    const lake = str(asRecord(fact.lake).id);
    const meta = [since && `valid since ${since}`, until && `until ${until}`, lake && lake !== 'think' ? lake : '']
      .filter(Boolean)
      .join(' · ');
    return [{ text, meta }];
  });
}

const PHRASES = {
  lakeRead: { id: 'lake-read', one: 'recalled from your lake' },
  lakeSave: { id: 'lake-save', one: 'saved to your lake' },
  hemilake: { id: 'hemilake', one: 'used Hemilake' },
  bash: { id: 'bash', one: 'ran a command', plural: 'ran {n} commands' },
  read: { id: 'read', one: 'read a file', plural: 'read {n} files', countBy: 'path' },
  edit: { id: 'edit', one: 'edited a file', plural: 'edited {n} files', countBy: 'path' },
  write: { id: 'write', one: 'wrote a file', plural: 'wrote {n} files', countBy: 'path' },
  code: { id: 'code-search', one: 'searched the code' },
  webSearch: { id: 'web-search', one: 'searched the web' },
  webFetch: { id: 'web-fetch', one: 'read a web page', plural: 'read {n} web pages' },
  plan: { id: 'plan', one: 'updated the checklist' },
  tools: { id: 'tool-search', one: 'loaded tools' },
} satisfies Record<string, StepPhrase>;

/** Channel families Hemilake (or a channel's own MCP) serves, by tool prefix. */
const CHANNELS: Array<{ prefixes: string[]; icon: StepIconKind; label: string; search: string; read: string; write: string }> = [
  { prefixes: ['slack_'], icon: 'slack', label: 'Slack', search: 'Searched Slack', read: 'Read Slack', write: 'Posted on Slack' },
  { prefixes: ['gmail_', 'o365_mail_'], icon: 'mail', label: 'mail', search: 'Searched mail', read: 'Read mail', write: 'Sent mail' },
  { prefixes: ['teams_'], icon: 'teams', label: 'Teams', search: 'Searched Teams', read: 'Read Teams', write: 'Sent on Teams' },
  { prefixes: ['gcal_', 'o365_calendar_', 'apple_calendar_', 'find_meeting_time'], icon: 'calendar', label: 'the calendar', search: 'Searched calendar', read: 'Read calendar', write: 'Updated calendar' },
  { prefixes: ['whatsapp_work_', 'whatsapp_'], icon: 'chat', label: 'WhatsApp', search: 'Searched WhatsApp', read: 'Read WhatsApp', write: 'Sent on WhatsApp' },
  { prefixes: ['telegram_'], icon: 'chat', label: 'Telegram', search: 'Searched Telegram', read: 'Read Telegram', write: 'Sent on Telegram' },
  { prefixes: ['signal_'], icon: 'chat', label: 'Signal', search: 'Searched Signal', read: 'Read Signal', write: 'Sent on Signal' },
  { prefixes: ['gdrive_', 'onedrive_', 'confluence_'], icon: 'docs', label: 'documents', search: 'Searched documents', read: 'Read document', write: 'Wrote document' },
  { prefixes: ['directory_'], icon: 'teams', label: 'the directory', search: 'Looked up people', read: 'Looked up people', write: 'Looked up people' },
];

/** Channel servers that are not Hemilake but name tools the same way (`mcp__slack__slack_search`). */
const CHANNEL_SERVERS: Record<string, string> = {
  slack: 'slack_',
  gmail: 'gmail_',
  teams: 'teams_',
  whatsapp: 'whatsapp_',
  telegram: 'telegram_',
};

const WRITE_ACTION = /(^|_)(send|reply|post|create|update|delete|respond|archive|set|add|draft|accept|react|reaction|open_dm)(_|$)/;
const SEARCH_ACTION = /(^|_)(search|find|lookup)(_|$)/;

/** Verbs of the lake's own tools (memory, brief), and of the channel tools the table names one by one. */
const LAKE_VERBS: Record<string, string> = {
  recall: 'Recalled',
  search_memory_facts: 'Searched facts',
  search_nodes: 'Looked up',
  search_episodes: 'Searched sources',
  get_episode: 'Opened source',
  get_episodes: 'Listed sources',
  get_episode_entities: 'Traced source',
  get_entity_edge: 'Opened fact',
  list_entities: 'Listed',
  meeting_prep: 'Prepared meeting',
  today_brief: 'Read your day',
  recent_events: 'Checked arrivals',
  summarize_saga: 'Summarised',
  add_memory: 'Saved to your lake',
  add_triplet: 'Saved to your lake',
  upsert_person: 'Saved to your lake',
};

const LAKE_WRITES = new Set(['add_memory', 'add_triplet', 'upsert_person']);

const CHANNEL_VERBS: Record<string, string> = {
  slack_get_history: 'Read channel',
  slack_get_thread: 'Read thread',
  slack_list_conversations: 'Listed channels',
  slack_get_user: 'Looked up',
  teams_list_chats: 'Listed chats',
  teams_list_teams: 'Listed teams',
  teams_list_channels: 'Listed channels',
};

function channelFor(tool: string) {
  return CHANNELS.find((channel) => channel.prefixes.some((prefix) => tool.startsWith(prefix)));
}

/** The most meaningful input of a call, on one line. */
const ARG_KEYS = [
  'query', 'command', 'cmd', 'file_path', 'path', 'filePath', 'notebook_path', 'pattern', 'url',
  'channel', 'chat', 'chat_jid', 'thread_ts', 'skill', 'name', 'title', 'subject', 'id', 'uuid', 'prompt', 'text',
];

function argOf(input: Record<string, unknown>, raw: unknown): string {
  for (const key of ARG_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value);
    if (typeof value === 'number') return String(value);
  }
  if (typeof raw === 'string') return oneLine(raw);
  const firstString = Object.values(input).find((value) => typeof value === 'string' && value.trim());
  return typeof firstString === 'string' ? oneLine(firstString) : '';
}

/** Short summary of a lake answer. */
function lakeResult(tool: string, payload: unknown): { result: string | null; facts: StepFact[] } {
  const record = asRecord(payload);
  if (tool === 'recall' || tool === 'meeting_prep') {
    const facts = Array.isArray(record.facts) ? record.facts.length : 0;
    const people = Array.isArray(record.people) ? record.people.length : 0;
    const parts = [plural(facts, 'fact')];
    if (people > 0) parts.push(plural(people, 'person', 'people'));
    return { result: parts.join(' · '), facts: factsOf(record.facts) };
  }
  if (tool === 'search_memory_facts') {
    return { result: plural(Array.isArray(record.facts) ? record.facts.length : 0, 'fact'), facts: factsOf(record.facts) };
  }
  if (tool === 'search_nodes' && Array.isArray(record.nodes)) {
    const nodes = record.nodes as unknown[];
    const people = nodes.filter((node) => (asRecord(node).labels as unknown[] | undefined)?.includes?.('Person')).length;
    const things = nodes.length - people;
    const parts = [];
    if (people > 0) parts.push(plural(people, 'person', 'people'));
    if (things > 0 || people === 0) parts.push(plural(things, 'thing'));
    return { result: parts.join(' · '), facts: [] };
  }
  if (tool === 'get_episode') {
    const source = str(record.source) || str(record.name);
    const date = shortDate(record.valid_at);
    return { result: [source, date].filter(Boolean).join(' · ') || null, facts: [] };
  }
  if (LAKE_WRITES.has(tool)) {
    return { result: 'queued', facts: [] };
  }
  return { result: countJsonAnswer(payload), facts: [] };
}

function channelResult(tool: string, payload: unknown): string | null {
  const record = asRecord(payload);
  if (tool === 'slack_get_thread' && Array.isArray(record.messages)) {
    return plural(Math.max(0, record.messages.length - 1), 'reply', 'replies');
  }
  if (WRITE_ACTION.test(tool)) {
    if (record.sent === true || record.success === true || record.done === true || typeof record.ts === 'string') return 'sent';
  }
  return countJsonAnswer(payload);
}

type Described = Omit<StepDescription, 'collapseKey' | 'errorLine' | 'resultTone' | 'toolName'> & {
  resultTone?: ResultTone;
};

function describeMcp(mcp: McpName, input: Record<string, unknown>, raw: unknown, payload: unknown, text: string): Described {
  const hemilake = isHemilakeServer(mcp.server);
  const tool = CHANNEL_SERVERS[mcp.server] && !mcp.tool.startsWith(CHANNEL_SERVERS[mcp.server])
    ? `${CHANNEL_SERVERS[mcp.server]}${mcp.tool}`
    : mcp.tool;
  const channel = channelFor(tool);
  const arg = argOf(input, raw);

  if (channel && (hemilake || CHANNEL_SERVERS[mcp.server])) {
    const isWrite = WRITE_ACTION.test(tool);
    const verb = CHANNEL_VERBS[tool] ?? (isWrite ? channel.write : SEARCH_ACTION.test(tool) ? channel.search : channel.read);
    const phrase: StepPhrase = isWrite
      ? { id: `${channel.icon}-${channel.label}-write`, one: channel.write.charAt(0).toLowerCase() + channel.write.slice(1) }
      : { id: `${channel.icon}-${channel.label}-read`, one: `read ${channel.label}` };
    return {
      icon: channel.icon,
      verb,
      arg,
      result: payload === undefined ? (text ? plural(countLines(text), 'line') : null) : channelResult(tool, payload),
      viaHemilake: hemilake,
      facts: [],
      phrase,
    };
  }

  if (hemilake) {
    const lakeVerb = LAKE_VERBS[tool];
    const { result, facts } = payload === undefined
      ? { result: text ? plural(countLines(text), 'line') : null, facts: [] }
      : lakeResult(tool, payload);
    return {
      icon: 'lake',
      verb: lakeVerb ?? humanizeName(tool),
      arg,
      result,
      viaHemilake: false,
      facts,
      phrase: LAKE_WRITES.has(tool) ? PHRASES.lakeSave : lakeVerb ? PHRASES.lakeRead : PHRASES.hemilake,
    };
  }

  const serverLabel = humanizeName(mcp.server.replace(/^plugin_[^_]+_/, ''));
  return {
    icon: 'tool',
    verb: humanizeName(tool),
    arg,
    result: payload === undefined ? (text ? plural(countLines(text), 'line') : null) : countJsonAnswer(payload),
    viaHemilake: false,
    facts: [],
    phrase: { id: `mcp-${mcp.server}`, one: `used ${serverLabel}` },
  };
}

function firstWord(command: string): string {
  const word = command.trim().split(/\s+/)[0] || 'command';
  return word.replace(/^.*\//, '');
}

function describeBuiltin(toolName: string, input: Record<string, unknown>, raw: unknown, text: string, result: ToolResult | null): Described {
  const arg = argOf(input, raw);
  const lines = countLines(text);
  switch (toolName) {
    case 'Bash':
    case 'shell':
    case 'exec_command': {
      const command = str(input.command) || str(input.cmd) || (typeof raw === 'string' ? raw : '');
      const description = str(input.description).trim();
      return {
        icon: 'bash',
        verb: description ? oneLine(description, 80) : firstWord(command),
        arg: oneLine(command),
        result: result ? (lines > 0 ? plural(lines, 'line') : 'no output') : null,
        viaHemilake: false,
        facts: [],
        phrase: PHRASES.bash,
      };
    }
    case 'Read': {
      const numLines = Number(asRecord(asRecord(result?.toolUseResult).file).numLines);
      const count = Number.isFinite(numLines) && numLines > 0 ? numLines : lines;
      return { icon: 'file', verb: 'Read', arg, result: result ? plural(count, 'line') : null, viaHemilake: false, facts: [], phrase: PHRASES.read };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'ApplyPatch':
      return { icon: 'file', verb: 'Edited', arg, result: null, viaHemilake: false, facts: [], phrase: PHRASES.edit };
    case 'Write': {
      const written = countLines(str(input.content));
      return { icon: 'file', verb: 'Wrote file', arg, result: written ? plural(written, 'line') : null, viaHemilake: false, facts: [], phrase: PHRASES.write };
    }
    case 'NotebookEdit':
      return { icon: 'file', verb: 'Edited notebook', arg, result: null, viaHemilake: false, facts: [], phrase: PHRASES.edit };
    case 'Grep':
    case 'Glob':
      return {
        icon: 'search',
        verb: toolName === 'Grep' ? 'Searched code' : 'Listed files',
        arg,
        result: result ? (lines > 0 ? plural(lines, toolName === 'Grep' ? 'match' : 'file', toolName === 'Grep' ? 'matches' : 'files') : 'nothing found') : null,
        viaHemilake: false,
        facts: [],
        phrase: PHRASES.code,
      };
    case 'WebSearch':
      return { icon: 'web', verb: 'Searched the web', arg, result: result ? plural(lines, 'line') : null, viaHemilake: false, facts: [], phrase: PHRASES.webSearch };
    case 'WebFetch':
      return { icon: 'web', verb: 'Read web page', arg, result: result ? plural(lines, 'line') : null, viaHemilake: false, facts: [], phrase: PHRASES.webFetch };
    case 'Skill': {
      const skill = str(input.skill) || str(input.name) || 'skill';
      return {
        icon: 'skill',
        verb: `Used skill “${skill}”`,
        arg: str(input.args),
        result: null,
        viaHemilake: false,
        facts: [],
        phrase: { id: `skill-${skill}`, one: `used skill “${skill}”` },
      };
    }
    case 'TodoWrite':
    case 'TodoRead':
    case 'UpdatePlan': {
      const todos = Array.isArray(input.todos) ? (input.todos as unknown[]) : [];
      const done = todos.filter((todo) => asRecord(todo).status === 'completed').length;
      return {
        icon: 'plan',
        verb: 'Updated the checklist',
        arg: '',
        result: todos.length ? `${done}/${todos.length} done` : null,
        viaHemilake: false,
        facts: [],
        phrase: PHRASES.plan,
      };
    }
    case 'ToolSearch':
      return { icon: 'search', verb: 'Loaded tools', arg, result: null, viaHemilake: false, facts: [], phrase: PHRASES.tools };
    default:
      return {
        icon: 'tool',
        verb: humanizeName(toolName),
        arg,
        result: result ? (lines > 0 ? plural(lines, 'line') : 'done') : null,
        viaHemilake: false,
        facts: [],
        phrase: { id: `tool-${toolName}`, one: `used ${humanizeName(toolName).toLowerCase()}` },
      };
  }
}

/** The error line of a failed call: Bash's exit code, else the first line that says something. */
function errorLineOf(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const first = lines.find((line) => !/^exit code \d+$/i.test(line)) ?? lines[0] ?? 'Failed';
  return oneLine(first, 200);
}

/**
 * Names one tool call. `input` is the parsed tool input (or the raw string a
 * provider sent), `result` the merged tool result, null while the call runs.
 */
export function describeStep(toolName: string, input: unknown, result: ToolResult | null | undefined): StepDescription {
  const record = asRecord(input);
  const text = resultText(result);
  const mcp = splitMcpName(toolName);
  const payload = result && mcp ? unwrap(parseJson(text)) : undefined;
  const described = mcp
    ? describeMcp(mcp, record, input, payload, text)
    : describeBuiltin(toolName, record, input, text, result ?? null);

  let resultTone: ResultTone = described.result ? 'ok' : 'muted';
  let resultLabel = described.result;
  let errorLine: string | null = null;

  if (result?.isError) {
    errorLine = errorLineOf(text);
    const exit = /exit code (\d+)/i.exec(text);
    resultLabel = exit ? `exit ${exit[1]}` : /denied|disallowed|cancelled/i.test(text) ? 'denied' : 'failed';
    resultTone = 'bad';
  } else if (payload !== undefined) {
    const softError = jsonError(payload);
    if (softError) {
      resultLabel = oneLine(softError, 60);
      resultTone = 'bad';
    }
  }

  return {
    ...described,
    toolName,
    result: resultLabel,
    resultTone,
    errorLine,
    collapseKey: `${toolName}\u0000${described.verb}`,
  };
}

/** Distinct values an input names, for phrases that count files rather than calls. */
function countKeyOf(input: unknown): string {
  const record = asRecord(input);
  return str(record.file_path) || str(record.path) || str(record.notebook_path) || JSON.stringify(record);
}

/**
 * The folded line's words: one phrase per kind in order of first use, counts
 * for repeats, the first letter capitalised. "Read 2 files, recalled from your
 * lake, read Slack, ran 3 commands".
 */
export function summarizeSteps(calls: Array<{ description: StepDescription; input: unknown }>): string {
  const order: string[] = [];
  const byPhrase = new Map<string, { phrase: StepPhrase; calls: number; keys: Set<string> }>();
  for (const call of calls) {
    const { phrase } = call.description;
    let entry = byPhrase.get(phrase.id);
    if (!entry) {
      entry = { phrase, calls: 0, keys: new Set() };
      byPhrase.set(phrase.id, entry);
      order.push(phrase.id);
    }
    entry.calls += 1;
    entry.keys.add(countKeyOf(call.input));
  }
  const words = order.map((id) => {
    const { phrase, calls, keys } = byPhrase.get(id)!;
    const n = phrase.countBy ? keys.size : calls;
    return n > 1 && phrase.plural ? phrase.plural.replace('{n}', String(n)) : phrase.one;
  });
  const sentence = words.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
