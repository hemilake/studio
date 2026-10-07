import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

const EFFORTS = ['low', 'medium', 'high'].map((value) => ({ value }));
const MODELS = [{ value: 'opus', label: 'Opus' }];

function renderMenu(adversarialMode: Parameters<typeof ComposerModelMenu>[0]['adversarialMode']) {
  render(
    <ComposerModelMenu
      effort="high"
      effortOptions={EFFORTS}
      onSelectEffort={vi.fn()}
      model="opus"
      modelOptions={MODELS}
      onSelectModel={vi.fn()}
      modelsLoading={false}
      adversarialMode={adversarialMode}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
}

describe('ComposerModelMenu on phones', () => {
  it('names the effort level on the trigger, since the picker is hidden there', () => {
    renderMenu(undefined);
    expect(screen.getByRole('button', { name: 'Select model and reasoning effort' }).textContent).toContain('· High');
  });

  it('turns adversarial mode on and picks adversaries without emptying the list', () => {
    const onToggle = vi.fn();
    const onChangeSelection = vi.fn();
    renderMenu({ enabled: false, selection: ['antigravity'], onToggle, onChangeSelection });

    fireEvent.click(screen.getByRole('menuitem', { name: /^Adversarial mode/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('menuitem', { name: /Codex/ }));
    expect(onChangeSelection).toHaveBeenLastCalledWith(['antigravity', 'codex']);

    fireEvent.click(screen.getByRole('menuitem', { name: /^Antigravity/ }));
    expect(onChangeSelection).toHaveBeenCalledTimes(1);
  });

  it('has no adversarial section when the provider cannot use it', () => {
    renderMenu(undefined);
    expect(screen.queryByRole('menuitem', { name: /Codex/ })).toBeNull();
  });
});
