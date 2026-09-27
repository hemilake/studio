import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import ComposerEffortPicker from '@/modules/chat/composer/ComposerEffortPicker';
import { getQuickEffortValues } from '@/modules/chat/utils/composerEffort';

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].map((value) => ({ value }));

describe('ComposerEffortPicker', () => {
  it('offers every effort except the menu-only ones', () => {
    expect(getQuickEffortValues(CLAUDE_EFFORTS)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('selects a level with one click on the segmented control', () => {
    const onSelectEffort = vi.fn();
    render(<ComposerEffortPicker effort="medium" effortOptions={CLAUDE_EFFORTS} onSelectEffort={onSelectEffort} />);

    const group = screen.getByRole('radiogroup');
    expect(within(group).getByRole('radio', { name: 'Med' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(within(group).getByRole('radio', { name: 'High' }));
    expect(onSelectEffort).toHaveBeenCalledWith('high');

    fireEvent.click(within(group).getByRole('radio', { name: 'Med' }));
    expect(onSelectEffort).toHaveBeenCalledTimes(1);
  });

  it('steps to the next level from the compact chip, wrapping at the end', () => {
    const onSelectEffort = vi.fn();
    const { rerender } = render(
      <ComposerEffortPicker effort="high" effortOptions={CLAUDE_EFFORTS} onSelectEffort={onSelectEffort} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /: High$/ }));
    expect(onSelectEffort).toHaveBeenLastCalledWith('xhigh');

    rerender(<ComposerEffortPicker effort="max" effortOptions={CLAUDE_EFFORTS} onSelectEffort={onSelectEffort} />);
    fireEvent.click(screen.getByRole('button', { name: /: Max$/ }));
    expect(onSelectEffort).toHaveBeenLastCalledWith('low');
  });

  it('renders nothing when the model takes no effort', () => {
    const { container } = render(
      <ComposerEffortPicker effort="default" effortOptions={[]} onSelectEffort={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
