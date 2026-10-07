import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectEmbedMode, parseConsoleMessage } from '@/shared/embedBridge';

type FakeWindow = {
  parent: unknown;
  location: { search: string };
  sessionStorage: Storage;
};

function fakeWindow(search: string, framed = true): Window {
  const store = new Map<string, string>();
  const win: FakeWindow = {
    parent: null,
    location: { search },
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    } as Storage,
  };
  win.parent = framed ? {} : win;
  return win as unknown as Window;
}

describe('detectEmbedMode', () => {
  it('is off for a page that is not framed, whatever the query says', () => {
    expect(detectEmbedMode(fakeWindow('?embed=full', false))).toBeNull();
  });

  it('takes the mode from the query and keeps it for later navigations in the tab', () => {
    const win = fakeWindow('?embed=compact');
    expect(detectEmbedMode(win)).toBe('compact');
    (win.location as { search: string }).search = '';
    expect(detectEmbedMode(win)).toBe('compact');
  });

  it('ignores unknown modes', () => {
    expect(detectEmbedMode(fakeWindow('?embed=sideways'))).toBeNull();
  });
});

describe('parseConsoleMessage', () => {
  it('accepts each message of the contract', () => {
    expect(parseConsoleMessage({ v: 1, type: 'auth', assertion: 'a.b.c' })).toEqual({ v: 1, type: 'auth', assertion: 'a.b.c' });
    expect(parseConsoleMessage({ v: 1, type: 'theme', mode: 'dark' })).toEqual({ v: 1, type: 'theme', mode: 'dark' });
    expect(parseConsoleMessage({ v: 1, type: 'navigate', path: '/session/abc-123' })).toEqual({ v: 1, type: 'navigate', path: '/session/abc-123' });
    expect(parseConsoleMessage({ v: 1, type: 'navigate', path: '/' })).toEqual({ v: 1, type: 'navigate', path: '/' });
    expect(parseConsoleMessage({ v: 1, type: 'focus' })).toEqual({ v: 1, type: 'focus' });
    expect(parseConsoleMessage({ v: 1, type: 'new', requestId: 'r1', prompt: 'Draft the reply' })).toEqual({
      v: 1, type: 'new', requestId: 'r1', prompt: 'Draft the reply', projectPath: null,
    });
    expect(parseConsoleMessage({ v: 1, type: 'recent.request', requestId: 'r2', limit: 500 })).toEqual({
      v: 1, type: 'recent.request', requestId: 'r2', limit: 50,
    });
  });

  it('drops anything without the version, of an unknown type or with a bad field', () => {
    for (const data of [
      null,
      'focus',
      [],
      { type: 'focus' },
      { v: 2, type: 'focus' },
      { v: 1, type: 'open', kind: 'person', id: 'x' },
      { v: 1, type: 'theme', mode: 'sepia' },
      { v: 1, type: 'navigate', path: '/settings' },
      { v: 1, type: 'navigate', path: 'https://evil.example/session/x' },
      { v: 1, type: 'navigate', path: '/session/../../etc' },
      { v: 1, type: 'new', prompt: 'no request id' },
      { v: 1, type: 'new', requestId: 'r', prompt: 'x'.repeat(100_001) },
      { v: 1, type: 'new', requestId: 'r', projectPath: 42 },
      { v: 1, type: 'auth', assertion: 7 },
    ]) {
      expect(parseConsoleMessage(data)).toBeNull();
    }
  });
});

describe('the bridge inside a frame', () => {
  const CONSOLE = 'https://lake.example.com';
  const originalParent = Object.getOwnPropertyDescriptor(window, 'parent');

  afterEach(() => {
    if (originalParent) {
      Object.defineProperty(window, 'parent', originalParent);
    }
    window.history.replaceState(null, '', '/');
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadFramedBridge() {
    const parent = { postMessage: vi.fn() };
    Object.defineProperty(window, 'parent', { configurable: true, get: () => parent });
    window.history.replaceState(null, '', '/?embed=full');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ origins: [CONSOLE], exchange: true }), { status: 200 })));
    vi.resetModules();
    const bridge = await import('@/shared/embedBridge');
    await bridge.startEmbedBridge();
    return { bridge, parent };
  }

  it('announces itself only to the configured console origin', async () => {
    const { bridge, parent } = await loadFramedBridge();
    expect(bridge.getEmbedMode()).toBe('full');
    expect(bridge.isEmbedExchangeAvailable()).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ v: 1, type: 'studio.ready', embed: 'full' }),
      CONSOLE,
    );
  });

  it('listens to the parent at the configured origin and to nobody else', async () => {
    const { bridge, parent } = await loadFramedBridge();
    const received: string[] = [];
    bridge.onConsoleMessage((message) => received.push(message.type));

    window.dispatchEvent(new MessageEvent('message', { data: { v: 1, type: 'focus' }, origin: 'https://evil.example', source: parent as unknown as Window }));
    window.dispatchEvent(new MessageEvent('message', { data: { v: 1, type: 'focus' }, origin: CONSOLE, source: window }));
    expect(received).toEqual([]);

    window.dispatchEvent(new MessageEvent('message', { data: { v: 1, type: 'focus' }, origin: CONSOLE, source: parent as unknown as Window }));
    expect(received).toEqual(['focus']);
  });

  it('passes ⌘J up to the console instead of keeping it', async () => {
    const { parent } = await loadFramedBridge();
    const event = new KeyboardEvent('keydown', { key: 'j', metaKey: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith({ v: 1, type: 'shortcut', combo: 'mod+j' }, CONSOLE);
  });
});
