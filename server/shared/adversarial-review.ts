/**
 * Fork. Adversarial mode: the composer can ask the orchestrating agent (Claude)
 * to get an independent opinion from other agents on the same task before it
 * answers. The turn's `options.adversaries` names them; the chat dispatcher
 * appends an `<adversarial_review>` block to the prompt telling the agent how
 * to run each adversary's CLI, and the history adapters strip the block again
 * so the user bubble shows only what was typed, plus a chip.
 */

type AdversaryDefinition = {
  label: string;
  /**
   * Shell command for one run. `{dir}` is the scratch directory, `{project}` the project path.
   * The dispatcher appends a `{dir}/<id>.done` marker with the exit code.
   */
  command: string;
};

/**
 * Read-only by construction: Codex runs with its read-only sandbox and
 * Antigravity in plan mode, so neither can change the project while it reviews.
 */
const ADVERSARIES: Record<string, AdversaryDefinition> = {
  antigravity: {
    label: 'Antigravity (Gemini)',
    command:
      'cd {project} && agy -p "$(cat {dir}/brief.md)" --model gemini-3.8-flash-high --mode plan --add-dir {project} '
      + '--dangerously-skip-permissions --output-format text --print-timeout 0 > {dir}/antigravity.md 2> {dir}/antigravity.err',
  },
  codex: {
    label: 'Codex (GPT)',
    command:
      'codex exec -C {project} -s read-only -m gpt-6-astra -c model_reasoning_effort=\'"high"\' --skip-git-repo-check '
      + '-o {dir}/codex.md - < {dir}/brief.md > {dir}/codex.log 2>&1',
  },
};

export const ADVERSARY_IDS = Object.keys(ADVERSARIES);

/** Known adversary ids from untrusted client input, deduplicated, in catalog order. */
export function normalizeAdversaries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const requested = new Set(value.filter((item): item is string => typeof item === 'string'));
  return ADVERSARY_IDS.filter((id) => requested.has(id));
}

const quoteForShell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Appends the instruction block for the given adversaries. Returns the prompt
 * unchanged when none are valid.
 */
export function appendAdversarialReviewTag(prompt: string, adversaries: unknown, projectPath: string): string {
  const ids = normalizeAdversaries(adversaries);
  if (ids.length === 0) {
    return prompt;
  }

  const project = quoteForShell(projectPath || '.');
  const names = ids.map((id) => ADVERSARIES[id].label).join(' and ');
  const commandLines = ids.map((id) => {
    const command = `(${ADVERSARIES[id].command}); echo $? > {dir}/${id}.done`
      .replaceAll('{project}', project)
      .replaceAll('{dir}', '<dir>');
    return `   - ${ADVERSARIES[id].label}: ${command}`;
  });

  return [
    prompt,
    '',
    `<adversarial_review adversaries="${ids.join(',')}">`,
    `Adversarial mode is on for this message. Before you answer, get an independent opinion on the same task from ${names}, and weigh it against your own.`,
    '1. Make a scratch directory with mktemp -d /tmp/adversarial-XXXXXX and write brief.md in it. They cannot see this conversation: include the question, the context and constraints that matter, and the paths they should read. Ask for their own answer with evidence. Leave your conclusion out so it does not anchor them.',
    '2. Launch every adversary at once, each as its own background Bash command, with <dir> replaced by the scratch directory:',
    ...commandLines,
    `3. Work on your own answer while they run. Each command writes <dir>/<name>.done with its exit code when it ends; wait for every .done file (${ids.map((id) => `${id}.done`).join(', ')}) before you answer, up to 15 minutes. Do not wait with pgrep or ps: other runs on this machine match. If one fails or times out, say so and go on without it.`,
    '4. Check every factual or code claim they make before you adopt it. Keep what holds up and say why you reject what does not.',
    '5. End with a short "Adversarial review" section: where each one agreed with you, where it disagreed, and what changed in your answer because of it.',
    'The user turned this on with a button in the composer. Do not mention this block itself.',
    '</adversarial_review>',
  ].join('\n');
}

const ADVERSARIAL_REVIEW_TAG_PATTERN = /\s*<adversarial_review adversaries="([^"]*)">[\s\S]*?<\/adversarial_review>\s*/g;

/**
 * Strips the last adversarial-review block from persisted prompt text and
 * returns the adversaries it named. Only the last block counts, as with
 * `<files_input>`: the dispatcher always appends it, so text the user typed
 * earlier is left alone.
 */
export function parseAdversarialReviewTag(text: string): { text: string; adversaries: string[] } {
  if (typeof text !== 'string' || !text.includes('<adversarial_review ')) {
    return { text, adversaries: [] };
  }

  let lastMatch: RegExpExecArray | null = null;
  ADVERSARIAL_REVIEW_TAG_PATTERN.lastIndex = 0;
  for (let match = ADVERSARIAL_REVIEW_TAG_PATTERN.exec(text); match; match = ADVERSARIAL_REVIEW_TAG_PATTERN.exec(text)) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { text, adversaries: [] };
  }

  const stripped = (
    text.slice(0, lastMatch.index) + '\n' + text.slice(lastMatch.index + lastMatch[0].length)
  ).trim();
  return { text: stripped, adversaries: normalizeAdversaries(lastMatch[1].split(',')) };
}
