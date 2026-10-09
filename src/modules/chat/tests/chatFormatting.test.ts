import assert from 'node:assert/strict';

import { describe, expect, it, test } from 'vitest';

import { promoteInlineMath, stripProposedPlanEnvelope } from '@/modules/chat/utils/chatFormatting';

test('stripProposedPlanEnvelope removes a complete outer plan envelope', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Session Timeline\n\nPlan body\n</proposed_plan>'),
    '# Session Timeline\n\nPlan body',
  );
});

test('stripProposedPlanEnvelope removes the opening tag while a plan is streaming', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Partial plan'),
    '# Partial plan',
  );
});

test('stripProposedPlanEnvelope preserves tags that are not the outer envelope', () => {
  const content = 'Use `<proposed_plan>` only for plans.';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

test('stripProposedPlanEnvelope preserves an unmatched terminal closing tag', () => {
  const content = 'Ordinary text that mentions a terminal tag.\n</proposed_plan>';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

describe('promoteInlineMath', () => {
  it('turns $…$ that reads as TeX into $$…$$', () => {
    const text = 'cada uno genera $0{,}5 \\times 120 / 3600 = 0{,}0167\\text{ Erlangs}$ en total';
    expect(promoteInlineMath(text)).toBe(
      'cada uno genera $$0{,}5 \\times 120 / 3600 = 0{,}0167\\text{ Erlangs}$$ en total',
    );
    expect(promoteInlineMath('el área es $x^2$ y $y$.')).toBe('el área es $$x^2$$ y $$y$$.');
  });

  it('leaves prices and plain dollars alone', () => {
    for (const text of [
      'cuesta $5 y $10 al mes',
      'entre $136K/año y $200K/año',
      'el precio es $5$10',
      'USD$ 30 o $ 40',
      'variables $HOME y $PATH',
      'gana $1,000 frente a $2,500',
    ]) {
      expect(promoteInlineMath(text)).toBe(text);
    }
  });

  it('turns \\(…\\) and \\[…\\] into $$', () => {
    expect(promoteInlineMath('y \\(x^2\\) aquí')).toBe('y $$x^2$$ aquí');
    expect(promoteInlineMath('\\[\nE = mc^2\n\\]')).toBe('$$\nE = mc^2\n$$');
    expect(promoteInlineMath('donde \\[a+b\\] vale')).toBe('donde $$a+b$$ vale');
  });

  it('does not touch code', () => {
    const fenced = '```bash\necho "$x^2$" \\(a\\)\n```';
    expect(promoteInlineMath(fenced)).toBe(fenced);
    expect(promoteInlineMath('run `echo $x_1$` now')).toBe('run `echo $x_1$` now');
    expect(promoteInlineMath('    indented $x^2$')).toBe('    indented $x^2$');
  });

  it('keeps existing $$ math as it is', () => {
    expect(promoteInlineMath('ya está $$x^2$$ bien')).toBe('ya está $$x^2$$ bien');
    expect(promoteInlineMath('$$\nx^2\n$$')).toBe('$$\nx^2\n$$');
  });
});
