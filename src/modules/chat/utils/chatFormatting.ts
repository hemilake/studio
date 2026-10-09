export function normalizeInlineCodeFences(text: string) {
  if (!text || typeof text !== 'string') return text;
  try {
    return text.replace(/```[ \t]*([^\n\r]+?)[ \t]*```/g, '`$1`');
  } catch {
    return text;
  }
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes Codex's outer plan transport envelope while preserving its Markdown.
 * The closing tag is optional because streamed plans expose the opening tag
 * before the complete response arrives.
 */
export function stripProposedPlanEnvelope(text: string) {
  if (!text || typeof text !== 'string') return text;

  const openingTag = /^\s*<proposed_plan>[ \t]*(?:\r?\n)?/i;
  if (!openingTag.test(text)) return text;

  const withoutOpeningTag = text.replace(openingTag, '');
  return withoutOpeningTag.replace(/(?:\r?\n)?[ \t]*<\/proposed_plan>\s*$/i, '');
}

export function formatUsageLimitText(text: string) {
  try {
    if (typeof text !== 'string') return text;
    return text.replace(/Claude AI usage limit reached\|(\d{10,13})/g, (match, ts) => {
      let timestampMs = parseInt(ts, 10);
      if (!Number.isFinite(timestampMs)) return match;
      if (timestampMs < 1e12) timestampMs *= 1000;
      const reset = new Date(timestampMs);

      const timeStr = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(reset);

      const offsetMinutesLocal = -reset.getTimezoneOffset();
      const sign = offsetMinutesLocal >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutesLocal);
      const offH = Math.floor(abs / 60);
      const offM = abs % 60;
      const gmt = `GMT${sign}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`;
      const tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const cityRaw = tzId.split('/').pop() || '';
      const city = cityRaw
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      const tzHuman = city ? `${gmt} (${city})` : gmt;

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateReadable = `${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()}`;

      return `Claude usage limit reached. Your limit will reset at **${timeStr} ${tzHuman}** - ${dateReadable}`;
    });
  } catch {
    return text;
  }
}

// Fork (inline math): `$…$` as math, under Pandoc's rule (no space just inside
// either dollar, no digit right after the closing one) and only when the inside
// reads as TeX: a command, a sub/superscript or braces, or a single letter.
// Prices such as "$5 and $10" stay text, which is why upstream keeps
// `singleDollarTextMath` off.
const INLINE_DOLLAR_MATH = /(^|[^\\$\w])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?![\d$\w])/g;
const TEX_LIKE = /\\[A-Za-z]+|[\^_{}]|^[A-Za-z]$/;
const PAREN_MATH = /\\\(([^\n]+?)\\\)/g;
const BRACKET_MATH = /\\\[([^\n]+?)\\\]/g;
const FENCE = /^ {0,3}(```|~~~)/;

const promoteSegment = (text: string): string =>
  text
    .replace(PAREN_MATH, (_, inner: string) => `$$${inner}$$`)
    .replace(BRACKET_MATH, (_, inner: string) => `$$${inner}$$`)
    .replace(INLINE_DOLLAR_MATH, (match, before: string, inner: string) =>
      TEX_LIKE.test(inner) ? `${before}$$${inner}$$` : match,
    );

/**
 * Rewrites the math a model writes as `$…$` (when it reads as TeX), `\(…\)`
 * and `\[…\]` (on one line, or with `\[` and `\]` on lines of their own) into
 * the `$$` that remark-math parses with `singleDollarTextMath` off. Fenced and
 * indented code and code spans are left alone.
 */
export function promoteInlineMath(text: string) {
  if (!text || typeof text !== 'string' || !/[$\\]/.test(text)) return text;
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const opener = FENCE.exec(line);
      if (opener) {
        if (fence === null) fence = opener[1];
        else if (opener[1] === fence) fence = null;
        return line;
      }
      if (fence !== null || /^( {4}|\t)/.test(line)) return line;
      const bare = line.trim();
      if (bare === '\\[' || bare === '\\]') return '$$';
      // Even indexes are text, odd ones `code spans`.
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, index) => (index % 2 ? part : promoteSegment(part)))
        .join('');
    })
    .join('\n');
}
