import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { PublicSharePage, SessionShareDialog } from '@/modules/share';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { resolvePublicShareTokenFromPathname } from '@/shared/utils';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('resolvePublicShareTokenFromPathname', () => {
  test('matches /share/:token at root and under a router basename', () => {
    assert.equal(resolvePublicShareTokenFromPathname('/share/tok_123', ''), 'tok_123');
    assert.equal(resolvePublicShareTokenFromPathname('/ai/share/tok_456', '/ai'), 'tok_456');
    assert.equal(resolvePublicShareTokenFromPathname('/session/abc', ''), null);
    assert.equal(resolvePublicShareTokenFromPathname('/', ''), null);
  });
});

describe('PublicSharePage', () => {
  test('renders shared items, Live pill, external links with noopener noreferrer, and disables workspace links', async () => {
    const fetchCalls: Array<{ url: string; headers?: HeadersInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, headers: init?.headers });

      if (url === '/api/appearance') {
        return new Response(JSON.stringify({ theme: 'hemilake' }), { status: 200 });
      }

      if (url === '/api/public/shares/test-token') {
        return new Response(
          JSON.stringify({
            title: 'Public Architecture Review',
            provider: 'claude',
            running: true,
            updatedAt: '2026-10-08T12:00:00.000Z',
            items: [
              {
                id: 'u-1',
                role: 'user',
                text: 'Please review the architecture',
                timestamp: '2026-10-08T12:00:00.000Z',
              },
              {
                id: 'a-1',
                role: 'assistant',
                text: 'See [docs](https://example.com/docs) and `src/App.tsx:10`.',
                timestamp: '2026-10-08T12:00:05.000Z',
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ETag: '"etag-v1"',
            },
          },
        );
      }

      return new Response('Not found', { status: 404 });
    });

    render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <PublicSharePage token="test-token" />
        </ThemeProvider>
      </I18nextProvider>,
    );

    await waitFor(() => {
      assert.ok(screen.getByText('Public Architecture Review'));
    });

    assert.ok(screen.getByTestId('share-live-pill'));
    assert.ok(screen.getByText('Please review the architecture'));

    const externalLink = screen.getByRole('link', { name: 'docs' });
    assert.equal(externalLink.getAttribute('href'), 'https://example.com/docs');
    assert.equal(externalLink.getAttribute('target'), '_blank');
    assert.equal(externalLink.getAttribute('rel'), 'noopener noreferrer');

    // Ensure no authenticated endpoints were called.
    for (const call of fetchCalls) {
      assert.ok(
        call.url === '/api/appearance' || call.url.startsWith('/api/public/shares/'),
        `Unexpected request from PublicSharePage: ${call.url}`,
      );
    }
  });

  test('shows unavailable state on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/appearance') {
        return new Response(JSON.stringify({ theme: 'hemilake' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'Share not found' }), { status: 404 });
    });

    render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <PublicSharePage token="revoked-token" />
        </ThemeProvider>
      </I18nextProvider>,
    );

    await waitFor(() => {
      assert.ok(screen.getByTestId('share-unavailable'));
    });
    assert.ok(screen.getByText('This link is no longer available'));
  });

  test('opens at the top by default without scrolling to bottom', async () => {
    const scrollIntoViewSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/appearance') {
        return new Response(JSON.stringify({ theme: 'hemilake' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          title: 'Top Default Session',
          provider: 'claude',
          focusId: null,
          running: false,
          updatedAt: '2026-10-08T12:00:00.000Z',
          items: [
            { id: 'u-1', role: 'user', text: 'First prompt', timestamp: '2026-10-08T12:00:00.000Z' },
            { id: 'a-1', role: 'assistant', text: 'First answer', timestamp: '2026-10-08T12:00:05.000Z' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <PublicSharePage token="top-token" />
        </ThemeProvider>
      </I18nextProvider>,
    );

    await waitFor(() => {
      assert.ok(screen.getByText('First prompt'));
    });

    const mainEl = container.querySelector('main');
    assert.ok(mainEl);
    assert.equal(mainEl.scrollTop, 0);
    assert.equal(scrollIntoViewSpy.mock.calls.length, 0);
    assert.equal(container.querySelector('[data-highlighted="true"]'), null);
  });

  test('scrolls to focusId on first load and highlights the focused item', async () => {
    const scrolledElementIds: string[] = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoViewMock() {
      scrolledElementIds.push((this as HTMLElement).id);
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/appearance') {
        return new Response(JSON.stringify({ theme: 'hemilake' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          title: 'Focused Session',
          provider: 'claude',
          focusId: 'a-2',
          running: false,
          updatedAt: '2026-10-08T12:00:00.000Z',
          items: [
            { id: 'u-1', role: 'user', text: 'First prompt', timestamp: '2026-10-08T12:00:00.000Z' },
            { id: 'a-1', role: 'assistant', text: 'First answer', timestamp: '2026-10-08T12:00:05.000Z' },
            { id: 'u-2', role: 'user', text: 'Second prompt', timestamp: '2026-10-08T12:01:00.000Z' },
            { id: 'a-2', role: 'assistant', text: 'Focused answer', timestamp: '2026-10-08T12:01:05.000Z' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <PublicSharePage token="focus-token" />
        </ThemeProvider>
      </I18nextProvider>,
    );

    await waitFor(() => {
      assert.ok(screen.getByText('Focused answer'));
    });

    assert.deepEqual(scrolledElementIds, ['a-2']);
    const focusedEl = document.getElementById('a-2');
    assert.ok(focusedEl);
    assert.equal(focusedEl.getAttribute('data-highlighted'), 'true');
    assert.ok(focusedEl.className.includes('hemi-share-focus-highlight'));
    assert.ok(focusedEl.className.includes('scroll-mt-16'));
  });

  test('URL #<item id> hash wins over focusId and handles special characters', async () => {
    const scrolledElementIds: string[] = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoViewMock() {
      scrolledElementIds.push((this as HTMLElement).id);
    };

    window.history.replaceState(null, '', '/share/hash-token#item%3A2.special');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/appearance') {
        return new Response(JSON.stringify({ theme: 'hemilake' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          title: 'Hash Override Session',
          provider: 'claude',
          focusId: 'u-1',
          running: false,
          updatedAt: '2026-10-08T12:00:00.000Z',
          items: [
            { id: 'u-1', role: 'user', text: 'Prompt 1', timestamp: '2026-10-08T12:00:00.000Z' },
            { id: 'item:2.special', role: 'assistant', text: 'Hash target answer', timestamp: '2026-10-08T12:00:05.000Z' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <PublicSharePage token="hash-token" />
        </ThemeProvider>
      </I18nextProvider>,
    );

    await waitFor(() => {
      assert.ok(screen.getByText('Hash target answer'));
    });

    assert.deepEqual(scrolledElementIds, ['item:2.special']);
    const hashEl = document.getElementById('item:2.special');
    assert.ok(hashEl);
    assert.equal(hashEl.getAttribute('data-highlighted'), 'true');
  });

  test('later polls do not move the reader and Jump to latest shows a dot on new items then scrolls to end', async () => {
    let pollCount = 0;
    const scrolledElementIds: string[] = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoViewMock() {
      scrolledElementIds.push((this as HTMLElement).id);
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/appearance') {
        return new Response(JSON.stringify({ theme: 'hemilake' }), { status: 200 });
      }
      pollCount += 1;
      const items =
        pollCount === 1
          ? [
              { id: 'u-1', role: 'user', text: 'First prompt', timestamp: '2026-10-08T12:00:00.000Z' },
              { id: 'a-1', role: 'assistant', text: 'First answer', timestamp: '2026-10-08T12:00:05.000Z' },
            ]
          : [
              { id: 'u-1', role: 'user', text: 'First prompt', timestamp: '2026-10-08T12:00:00.000Z' },
              { id: 'a-1', role: 'assistant', text: 'First answer', timestamp: '2026-10-08T12:00:05.000Z' },
              { id: 'u-2', role: 'user', text: 'Newly arrived prompt', timestamp: '2026-10-08T12:00:10.000Z' },
            ];

      return new Response(
        JSON.stringify({
          title: 'Polling Session',
          provider: 'claude',
          focusId: null,
          running: true,
          updatedAt: `2026-10-08T12:00:0${pollCount}.000Z`,
          items,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ETag: `"etag-${pollCount}"`,
          },
        },
      );
    });

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <PublicSharePage token="poll-token" />
        </ThemeProvider>
      </I18nextProvider>,
    );

    await waitFor(() => {
      assert.ok(screen.getByText('First answer'));
    });

    const mainEl = container.querySelector('main') as HTMLElement;
    assert.ok(mainEl);
    Object.defineProperty(mainEl, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(mainEl, 'clientHeight', { value: 400, configurable: true });
    mainEl.scrollTop = 0;

    // Jump to latest button is visible, initially without the new-items dot.
    const jumpButton = screen.getByTestId('share-jump-to-latest');
    assert.ok(jumpButton);
    assert.equal(screen.queryByTestId('share-jump-to-latest-dot'), null);

    // Wait for the 3s running poll to bring in u-2.
    await waitFor(
      () => {
        assert.ok(screen.getByText('Newly arrived prompt'));
      },
      { timeout: 4500 },
    );

    // Reader was not moved by the poll (scrollTop stayed 0), and the dot is now shown.
    assert.equal(mainEl.scrollTop, 0);
    assert.ok(screen.getByTestId('share-jump-to-latest-dot'));

    // Clicking Jump to latest scrolls to the end and hides the button/dot.
    fireEvent.click(screen.getByTestId('share-jump-to-latest'));
    assert.equal(mainEl.scrollTop, 1200);
    assert.ok(scrolledElementIds.includes('u-2'));
    assert.equal(screen.queryByTestId('share-jump-to-latest'), null);
  });
});

describe('SessionShareDialog', () => {
  test('creates a share link, toggles hidden items and focusId via PATCH, and revokes with confirmation', async () => {
    let shareCreated = false;
    let hiddenIds: string[] = [];
    let focusId: string | null = null;
    const patchPayloads: Array<Record<string, unknown>> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method || 'GET';

      if (url.startsWith('/api/shares?sessionId=') && method === 'GET') {
        if (!shareCreated) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
        return new Response(
          JSON.stringify({
            id: 'share-1',
            token: 'tok-xyz',
            urlPath: '/share/tok-xyz',
            title: 'Demo Session',
            hiddenIds,
            focusId,
            createdAt: '2026-10-08T12:00:00.000Z',
            expiresAt: null,
          }),
          { status: 200 },
        );
      }

      if (url === '/api/shares' && method === 'POST') {
        shareCreated = true;
        return new Response(
          JSON.stringify({
            id: 'share-1',
            token: 'tok-xyz',
            urlPath: '/share/tok-xyz',
            title: 'Demo Session',
            hiddenIds: [],
            focusId: null,
            createdAt: '2026-10-08T12:00:00.000Z',
            expiresAt: null,
          }),
          { status: 200 },
        );
      }

      if (url === '/api/shares/share-1/preview' && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'share-1',
            token: 'tok-xyz',
            urlPath: '/share/tok-xyz',
            title: 'Demo Session',
            hiddenIds,
            focusId,
            createdAt: '2026-10-08T12:00:00.000Z',
            expiresAt: null,
            running: false,
            items: [
              {
                id: 'item-1',
                role: 'user',
                text: 'First prompt in session',
                timestamp: '2026-10-08T12:00:00.000Z',
                hidden: hiddenIds.includes('item-1'),
              },
              {
                id: 'item-2',
                role: 'assistant',
                text: 'Assistant response in session',
                timestamp: '2026-10-08T12:00:02.000Z',
                hidden: hiddenIds.includes('item-2'),
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url === '/api/shares/share-1' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        patchPayloads.push(body);
        if (Array.isArray(body.hiddenIds)) {
          hiddenIds = body.hiddenIds as string[];
        }
        if ('focusId' in body) {
          focusId = (body.focusId as string | null) ?? null;
        }
        return new Response(
          JSON.stringify({
            id: 'share-1',
            token: 'tok-xyz',
            urlPath: '/share/tok-xyz',
            title: typeof body.title === 'string' ? body.title : 'Demo Session',
            hiddenIds,
            focusId,
            createdAt: '2026-10-08T12:00:00.000Z',
            expiresAt: null,
          }),
          { status: 200 },
        );
      }

      if (url === '/api/shares/share-1' && method === 'DELETE') {
        shareCreated = false;
        return new Response(JSON.stringify({ success: true, id: 'share-1' }), { status: 200 });
      }

      return new Response('Not found', { status: 404 });
    });

    render(
      <I18nextProvider i18n={i18n}>
        <SessionShareDialog
          sessionId="sess-1"
          sessionTitle="Demo Session"
          provider="claude"
        />
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share session' }));

    await waitFor(() => {
      assert.ok(screen.getByRole('button', { name: 'Create public link' }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create public link' }));

    await waitFor(() => {
      assert.ok(screen.getByText('First prompt in session'));
    });

    // Mark second item as "Open here"
    const openHereButtons = screen.getAllByRole('button', { name: 'Open here' });
    fireEvent.click(openHereButtons[1]);

    await waitFor(() => {
      assert.equal(patchPayloads.length, 1);
      assert.equal(patchPayloads[0].focusId, 'item-2');
      assert.ok(screen.getByTestId('share-preview-focus-badge'));
    });

    // Clear focus with "From the beginning"
    fireEvent.click(screen.getByRole('button', { name: 'From the beginning' }));

    await waitFor(() => {
      assert.equal(patchPayloads.length, 2);
      assert.equal(patchPayloads[1].focusId, null);
      assert.equal(screen.queryByTestId('share-preview-focus-badge'), null);
    });

    // Toggle hiding the first item
    const hideButtons = screen.getAllByRole('button', { name: 'Hide from shared view' });
    fireEvent.click(hideButtons[0]);

    await waitFor(() => {
      assert.equal(patchPayloads.length, 3);
      assert.deepEqual(patchPayloads[2].hiddenIds, ['item-1']);
    });

    // Stop sharing requires confirmation
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm stop sharing' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      assert.ok(screen.getByRole('button', { name: 'Create public link' }));
    });
  });
});
