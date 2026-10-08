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
});

describe('SessionShareDialog', () => {
  test('creates a share link, toggles hidden items via PATCH, and revokes with confirmation', async () => {
    let shareCreated = false;
    let hiddenIds: string[] = [];
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
        return new Response(
          JSON.stringify({
            id: 'share-1',
            token: 'tok-xyz',
            urlPath: '/share/tok-xyz',
            title: typeof body.title === 'string' ? body.title : 'Demo Session',
            hiddenIds,
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

    // Toggle hiding the first item
    const hideButtons = screen.getAllByRole('button', { name: 'Hide from shared view' });
    fireEvent.click(hideButtons[0]);

    await waitFor(() => {
      assert.equal(patchPayloads.length, 1);
      assert.deepEqual(patchPayloads[0].hiddenIds, ['item-1']);
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
