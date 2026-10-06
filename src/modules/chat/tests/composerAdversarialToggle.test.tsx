import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import ComposerAdversarialToggle from '@/modules/chat/composer/ComposerAdversarialToggle';
import { normalizeAdversarySelection } from '@/modules/chat/utils/adversarialMode';

describe('ComposerAdversarialToggle', () => {
  it('turns the mode on and off with one click on the icon', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ComposerAdversarialToggle enabled={false} selection={['antigravity']} onToggle={onToggle} onChangeSelection={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { pressed: false }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <ComposerAdversarialToggle enabled selection={['antigravity', 'codex']} onToggle={onToggle} onChangeSelection={vi.fn()} />,
    );
    // With more than one adversary the icon carries a count.
    expect(screen.getByRole('button', { pressed: true }).textContent).toBe('2');
  });

  it('adds and removes adversaries from the menu but never empties the list', () => {
    const onChangeSelection = vi.fn();
    render(
      <ComposerAdversarialToggle enabled={false} selection={['antigravity']} onToggle={vi.fn()} onChangeSelection={onChangeSelection} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Adversaries' }));

    fireEvent.click(screen.getByRole('menuitem', { name: /Codex/ }));
    expect(onChangeSelection).toHaveBeenLastCalledWith(['antigravity', 'codex']);

    fireEvent.click(screen.getByRole('menuitem', { name: /Antigravity/ }));
    expect(onChangeSelection).toHaveBeenCalledTimes(1);
  });

  it('keeps only known adversaries in catalog order', () => {
    expect(normalizeAdversarySelection(['codex', 'x', 'antigravity'])).toEqual(['antigravity', 'codex']);
    expect(normalizeAdversarySelection('codex')).toEqual([]);
  });
});
