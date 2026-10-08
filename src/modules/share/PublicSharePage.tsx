import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Markdown } from '@/modules/chat';
import { api } from '@/shared/api';
import { BrandMark, BrandWordmark, LLMProviderLogo, useBrandName } from '@/shared/ui';

type SharedItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
};

type PublicShareResponse = {
  title: string;
  provider: string;
  items: SharedItem[];
  running: boolean;
  updatedAt: string;
};

type PublicSharePageProps = {
  token: string;
};

const RUNNING_POLL_INTERVAL_MS = 3_000;
const IDLE_POLL_INTERVAL_MS = 15_000;
const SCROLL_BOTTOM_THRESHOLD_PX = 48;

function resolveProviderDisplayName(provider: string, translate: (key: string, options?: Record<string, unknown>) => string): string {
  switch (provider) {
    case 'cursor':
      return translate('messageTypes.cursor', { defaultValue: 'Cursor' });
    case 'codex':
      return translate('messageTypes.codex', { defaultValue: 'Codex' });
    case 'opencode':
      return translate('messageTypes.opencode', { defaultValue: 'OpenCode' });
    case 'antigravity':
      return translate('messageTypes.antigravity', { defaultValue: 'Antigravity' });
    default:
      return translate('messageTypes.claude', { defaultValue: 'Claude' });
  }
}

function formatShortTime(timestamp: string): string {
  if (!timestamp) {
    return '';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Rendered by `App` at `/share/:token` outside the authenticated provider tree
 * to display a public, read-only, live-updating view of a shared session.
 */
export function PublicSharePage({ token }: PublicSharePageProps) {
  const { t } = useTranslation('chat');
  const brandName = useBrandName();

  // Holds the latest public share payload fetched from `/api/public/shares/:token`.
  const [shareData, setShareData] = useState<PublicShareResponse | null>(null);
  // Tracks whether the first fetch is still in flight so an initial loading state is shown.
  const [isLoading, setIsLoading] = useState(true);
  // Set to true when the server responds 404 (unknown, revoked or expired token), stopping polling.
  const [isUnavailable, setIsUnavailable] = useState(false);
  // Tracks whether the browser tab is currently visible so polling switches between 3 s and 15 s.
  const [isTabVisible, setIsTabVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );

  const etagRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    isAtBottomRef.current = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }
    const onVisibilityChange = () => {
      setIsTabVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    if (shareData?.title) {
      document.title = `${shareData.title} - ${brandName}`;
    } else {
      document.title = brandName;
    }
  }, [brandName, shareData?.title]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isAtBottomRef.current) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [shareData?.items]);

  const fetchShare = useCallback(
    async (signal?: AbortSignal): Promise<'ok' | 'not_modified' | 'unavailable' | 'error'> => {
      try {
        const response = await api.publicShares.get(token, {
          etag: etagRef.current,
          signal,
        });

        if (response.status === 404) {
          setIsUnavailable(true);
          setIsLoading(false);
          return 'unavailable';
        }

        if (response.status === 304) {
          setIsLoading(false);
          return 'not_modified';
        }

        if (!response.ok) {
          setIsLoading(false);
          return 'error';
        }

        const nextEtag = response.headers.get('ETag');
        if (nextEtag) {
          etagRef.current = nextEtag;
        }

        const payload = (await response.json()) as PublicShareResponse;
        setShareData(payload);
        setIsLoading(false);
        return 'ok';
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') {
          return 'error';
        }
        setIsLoading(false);
        return 'error';
      }
    },
    [token],
  );

  useEffect(() => {
    etagRef.current = null;
    const controller = new AbortController();
    void Promise.resolve().then(() => fetchShare(controller.signal));
    return () => controller.abort();
  }, [fetchShare]);

  useEffect(() => {
    if (isUnavailable || isLoading) {
      return undefined;
    }

    const intervalMs =
      isTabVisible && shareData?.running
        ? RUNNING_POLL_INTERVAL_MS
        : IDLE_POLL_INTERVAL_MS;

    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void fetchShare(controller.signal);
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [fetchShare, isLoading, isTabVisible, isUnavailable, shareData?.running]);

  const providerLabel = resolveProviderDisplayName(shareData?.provider || 'claude', t);

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[54.25rem] items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex items-center gap-2 text-foreground" aria-label={brandName}>
              <BrandMark className="h-5 w-5 flex-shrink-0" />
              <BrandWordmark className="hidden text-sm font-semibold sm:inline" />
            </div>
            {shareData?.title && (
              <>
                <span className="text-muted-foreground/50" aria-hidden="true">
                  /
                </span>
                <h1 className="truncate text-sm font-medium text-foreground sm:text-base">
                  {shareData.title}
                </h1>
              </>
            )}
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            {shareData?.running && !isUnavailable && (
              <span
                data-testid="share-live-pill"
                className="inline-flex items-center gap-1.5 rounded-full border border-hemi-copper/40 bg-hemi-copper/10 px-2.5 py-0.5 text-xs font-medium text-hemi-copper-text"
              >
                <span className="h-2 w-2 animate-pulse rounded-full bg-hemi-copper" />
                {t('share.public.live', { defaultValue: 'Live' })}
              </span>
            )}
            <span className="rounded-full border border-border/70 bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground">
              {t('share.public.readOnly', { defaultValue: 'Read-only' })}
            </span>
          </div>
        </div>
      </header>

      <main
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div className="mx-auto w-full max-w-[54.25rem] space-y-5 px-4 py-6">
          {isUnavailable ? (
            <div
              data-testid="share-unavailable"
              className="mx-auto my-16 max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-sm"
            >
              <p className="text-base font-medium text-foreground">
                {t('share.public.unavailable', {
                  defaultValue: 'This link is no longer available',
                })}
              </p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {t('share.public.unavailableHint', {
                  defaultValue: 'The owner may have stopped sharing this session or the link has expired.',
                })}
              </p>
            </div>
          ) : isLoading && !shareData ? (
            <div className="my-16 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-muted-foreground" />
              <span>{t('share.public.loading', { defaultValue: 'Loading shared conversation…' })}</span>
            </div>
          ) : shareData && shareData.items.length === 0 ? (
            <div className="my-16 text-center text-sm text-muted-foreground">
              {t('share.public.empty', { defaultValue: 'No messages in this shared session yet.' })}
            </div>
          ) : (
            shareData?.items.map((item) => {
              const timeLabel = formatShortTime(item.timestamp);

              if (item.role === 'user') {
                return (
                  <div
                    key={item.id}
                    data-testid="share-item-user"
                    className="flex justify-end"
                  >
                    <div className="max-w-full rounded-2xl rounded-br-md border border-border/60 bg-muted/60 px-3.5 py-2.5 text-foreground shadow-sm dark:bg-gray-800/60 sm:max-w-[85%] sm:px-4">
                      <div dir="auto" className="break-words text-[15px] leading-[1.65]">
                        <Markdown
                          breaks
                          disableWorkspaceLinks
                          className="prose prose-sm max-w-none text-[15px] leading-[1.65] dark:prose-invert"
                        >
                          {item.text}
                        </Markdown>
                      </div>
                      {timeLabel && (
                        <div className="mt-1 flex items-center justify-end text-xs text-muted-foreground">
                          <span>{timeLabel}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={item.id}
                  data-testid="share-item-assistant"
                  className="w-full"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md p-0.5 text-foreground">
                      <LLMProviderLogo provider={shareData.provider} className="h-full w-full" />
                    </div>
                    <span className="text-[13.5px] font-medium text-foreground">
                      {providerLabel}
                    </span>
                    {timeLabel && (
                      <span className="font-mono text-[11px] text-muted-foreground/70">
                        {timeLabel}
                      </span>
                    )}
                  </div>
                  <div dir="auto" className="text-sm text-gray-700 dark:text-gray-300">
                    <Markdown
                      disableWorkspaceLinks
                      className="prose prose-sm prose-gray max-w-none text-[15px] leading-[1.65] dark:prose-invert"
                    >
                      {item.text}
                    </Markdown>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </main>
    </div>
  );
}
