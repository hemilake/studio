import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { ClaudeConnectionPanel, HemilakeLakePanel, useHemilakeSetup } from '@/modules/hemilake-setup';
import type { HemilakeSetupStatus } from '@/modules/hemilake-setup/useHemilakeSetup';

/**
 * The standalone setup (no hemi around Studio): the panels drive the server through `api.hemilakeSetup`, and run
 * Claude Code's own commands (install, `claude mcp login hemilake`) in the terminal modal, stubbed here.
 */

const calls: { name: string; body?: unknown }[] = [];
let status: HemilakeSetupStatus;
let embed = false;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/shared/embedBridge', () => ({ getEmbedMode: () => (embed ? 'console' : null) }));

vi.mock('@/modules/provider-auth', () => ({
  ProviderLoginModal: ({ customCommand }: { customCommand: string }) => <div data-testid="terminal">{customCommand}</div>,
}));

vi.mock('@/shared/api', () => {
  const json = (data: unknown, ok = true) => Promise.resolve({ ok, json: async () => data });
  return {
    api: {
      hemilakeSetup: {
        status: () => {
          calls.push({ name: 'status' });
          return json(status);
        },
        saveClaudeConnection: (body: unknown) => {
          calls.push({ name: 'save', body });
          status = { ...status, connection: { mode: 'gateway', baseUrl: 'https://litellm.example.com' } };
          return json({ mode: 'gateway', baseUrl: 'https://litellm.example.com' });
        },
        connectLake: (address: string) => {
          calls.push({ name: 'lake', body: address });
          status = { ...status, lake: { ...status.lake, url: 'https://elena.cloud.hemilake.app/mcp', state: 'needs-sign-in', plugin: true } };
          return json({ url: 'https://elena.cloud.hemilake.app/mcp', replaced: ['hemilake@hemilake'] });
        },
      },
    },
  };
});

function Harness({ which }: { which: 'claude' | 'lake' }) {
  const setup = useHemilakeSetup();
  if (!setup.status) return null;
  return which === 'claude' ? <ClaudeConnectionPanel setup={setup} /> : <HemilakeLakePanel setup={setup} />;
}

beforeEach(() => {
  calls.length = 0;
  embed = false;
  status = {
    claude: { installed: true, installCommand: 'curl -fsSL https://claude.ai/install.sh | bash' },
    connection: { mode: null, baseUrl: null },
    lake: { url: null, state: null, loginCommand: 'claude mcp login plugin:hemilake:hemilake', plugin: false },
  };
});

test('without Claude Code the panel offers its installer in the terminal', async () => {
  status.claude.installed = false;
  render(<Harness which="claude" />);
  fireEvent.click(await screen.findByText('hemilakeSetup.claude.install'));
  assert.equal(screen.getByTestId('terminal').textContent, 'curl -fsSL https://claude.ai/install.sh | bash');
});

test('a gateway is saved with its address and key', async () => {
  render(<Harness which="claude" />);
  fireEvent.click(await screen.findByText('hemilakeSetup.claude.modeGateway'));
  fireEvent.change(screen.getByPlaceholderText('https://litellm.example.com'), { target: { value: 'https://litellm.example.com' } });
  fireEvent.change(screen.getByPlaceholderText('hemilakeSetup.claude.gatewayKey'), { target: { value: 'sk-gw' } });
  fireEvent.click(screen.getByText('hemilakeSetup.save'));
  await waitFor(() => assert.ok(calls.some((call) => call.name === 'save')));
  assert.deepEqual(calls.find((call) => call.name === 'save')?.body, { mode: 'gateway', baseUrl: 'https://litellm.example.com', token: 'sk-gw' });
  await screen.findByText('hemilakeSetup.saved');
});

test('connecting the lake adds it, then opens its sign-in in the terminal', async () => {
  render(<Harness which="lake" />);
  fireEvent.change(await screen.findByPlaceholderText('nombre.cloud.hemilake.app'), { target: { value: 'elena.cloud.hemilake.app' } });
  fireEvent.click(screen.getByText('hemilakeSetup.lake.connect'));
  await waitFor(() => assert.equal(screen.getByTestId('terminal').textContent, 'claude mcp login plugin:hemilake:hemilake'));
  await screen.findByText('hemilakeSetup.lake.replaced');
  assert.deepEqual(calls.find((call) => call.name === 'lake')?.body, 'elena.cloud.hemilake.app');
  await screen.findByText('elena.cloud.hemilake.app');
});

test('inside the console nothing renders and the server is never asked', async () => {
  embed = true;
  const { container } = render(<Harness which="lake" />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(container.innerHTML, '');
  assert.equal(calls.length, 0);
});
