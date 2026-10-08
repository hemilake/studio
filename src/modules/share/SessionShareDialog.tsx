import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Share2,
  Trash2,
  X,
} from 'lucide-react';

import { api } from '@/shared/api';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Input,
} from '@/shared/ui';
import { copyTextToClipboard, detectRouterBasename } from '@/shared/utils';

type ShareRecord = {
  id: string;
  token: string;
  urlPath: string;
  title: string | null;
  hiddenIds: string[];
  createdAt: string;
  expiresAt: string | null;
};

type SharePreviewItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  hidden: boolean;
};

type SharePreviewPayload = ShareRecord & {
  items: SharePreviewItem[];
  running: boolean;
};

type SessionShareDialogProps = {
  sessionId: string;
  sessionTitle?: string;
  provider: string;
};

function truncatePreviewText(text: string, maxLength = 140): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function buildPublicShareUrl(token: string): string {
  if (typeof window === 'undefined') {
    return `/share/${token}`;
  }
  const basename = detectRouterBasename();
  return `${window.location.origin}${basename}/share/${token}`;
}

/**
 * Rendered by `ChatMessagesPane` next to `ChatExportMenu` so the owner can
 * create, customize, preview, and revoke a public read-only link for the
 * active session.
 */
export function SessionShareDialog({
  sessionId,
  sessionTitle,
  provider,
}: SessionShareDialogProps) {
  const { t } = useTranslation('chat');

  // Controls whether the Share modal dialog is open.
  const [open, setOpen] = useState(false);
  // Holds the active share record and candidate preview items when a share exists.
  const [preview, setPreview] = useState<SharePreviewPayload | null>(null);
  // Tracks initial lookup or share creation/revocation work so buttons disable and show a spinner.
  const [busy, setBusy] = useState(false);
  // Editable title draft bound to the title input before saving via PATCH.
  const [titleDraft, setTitleDraft] = useState('');
  // Indicates whether the public URL was just copied to the clipboard.
  const [copied, setCopied] = useState(false);
  // Tracks which item id is currently saving a hide/show toggle.
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Requires a second click to confirm revoking the public link.
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  // Stores any user-facing error message from share API calls.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadShareAndPreview = useCallback(async (shareId: string) => {
    const previewRes = await api.shares.preview(shareId);
    if (!previewRes.ok) {
      throw new Error('Failed to load share preview');
    }
    const data = (await previewRes.json()) as SharePreviewPayload;
    setPreview(data);
    setTitleDraft(data.title || sessionTitle || '');
  }, [sessionTitle]);

  const handleDialogOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    setConfirmingRevoke(false);
    setErrorMessage(null);
    if (nextOpen) {
      setBusy(true);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    let cancelled = false;

    api.shares
      .getBySession(sessionId)
      .then(async (response) => {
        if (cancelled) {
          return;
        }
        if (response.status === 404) {
          setPreview(null);
          setTitleDraft(sessionTitle || '');
          return;
        }
        if (!response.ok) {
          throw new Error('Failed to check existing share');
        }
        const existing = (await response.json()) as ShareRecord;
        if (!cancelled) {
          await loadShareAndPreview(existing.id);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadShareAndPreview, open, sessionId, sessionTitle]);

  const handleCreateShare = async () => {
    setBusy(true);
    setErrorMessage(null);
    try {
      const response = await api.shares.create({ sessionId, provider });
      if (!response.ok) {
        throw new Error('Unable to create share link');
      }
      const created = (await response.json()) as ShareRecord;
      await loadShareAndPreview(created.id);
    } catch {
      setErrorMessage(
        t('share.errors.createFailed', { defaultValue: 'Unable to create public link.' }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSaveTitle = async () => {
    if (!preview) {
      return;
    }
    const trimmed = titleDraft.trim();
    if (trimmed === (preview.title || '').trim()) {
      return;
    }

    try {
      const response = await api.shares.update(preview.id, {
        title: trimmed || null,
      });
      if (response.ok) {
        const updated = (await response.json()) as ShareRecord;
        setPreview((current) =>
          current ? { ...current, title: updated.title } : current,
        );
      }
    } catch {
      setErrorMessage(
        t('share.errors.updateFailed', { defaultValue: 'Unable to save changes.' }),
      );
    }
  };

  const handleToggleItemHidden = async (item: SharePreviewItem) => {
    if (!preview) {
      return;
    }

    const nextHidden = !item.hidden;
    const nextHiddenIds = nextHidden
      ? Array.from(new Set([...preview.hiddenIds, item.id]))
      : preview.hiddenIds.filter((id) => id !== item.id);

    setTogglingId(item.id);
    setErrorMessage(null);

    // Optimistic update so the toggle feels instant.
    setPreview((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        hiddenIds: nextHiddenIds,
        items: current.items.map((entry) =>
          entry.id === item.id ? { ...entry, hidden: nextHidden } : entry,
        ),
      };
    });

    try {
      const response = await api.shares.update(preview.id, {
        hiddenIds: nextHiddenIds,
      });
      if (!response.ok) {
        throw new Error('Failed to update hidden items');
      }
    } catch {
      await loadShareAndPreview(preview.id);
      setErrorMessage(
        t('share.errors.updateFailed', { defaultValue: 'Unable to save changes.' }),
      );
    } finally {
      setTogglingId(null);
    }
  };

  const handleRevokeShare = async () => {
    if (!preview) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      const response = await api.shares.revoke(preview.id);
      if (!response.ok) {
        throw new Error('Failed to revoke share');
      }
      setPreview(null);
      setConfirmingRevoke(false);
    } catch {
      setErrorMessage(
        t('share.errors.revokeFailed', { defaultValue: 'Unable to stop sharing.' }),
      );
    } finally {
      setBusy(false);
    }
  };

  const shareUrl = preview ? buildPublicShareUrl(preview.token) : '';

  const handleCopyUrl = async () => {
    if (!shareUrl) {
      return;
    }
    const ok = await copyTextToClipboard(shareUrl);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogTrigger
        aria-label={t('share.trigger', { defaultValue: 'Share session' })}
        title={t('share.trigger', { defaultValue: 'Share session' })}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border/50 bg-background/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Share2 className="h-4 w-4" />
      </DialogTrigger>

      <DialogContent className="max-h-[85vh] w-[92vw] max-w-xl overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-hemi-copper-text" />
            <DialogTitle className="not-sr-only text-base font-semibold text-foreground">
              {t('share.heading', { defaultValue: 'Share session' })}
            </DialogTitle>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t('misc.close', { defaultValue: 'Close' })}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[calc(85vh-4rem)] space-y-4 overflow-y-auto p-5">
          {errorMessage && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errorMessage}
            </div>
          )}

          {busy && !preview ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t('share.loading', { defaultValue: 'Loading share settings…' })}</span>
            </div>
          ) : !preview ? (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t('share.description', {
                  defaultValue:
                    'Publish a read-only link that anyone can open without signing in. Only your prompts and the assistant’s text outputs are shown — tool calls, file contents, and thinking stay private.',
                })}
              </p>
              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() => void handleCreateShare()}
                  disabled={busy}
                  className="gap-2"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Link2 className="h-4 w-4" />
                  )}
                  {t('share.createLink', { defaultValue: 'Create public link' })}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="share-public-url"
                  className="block text-xs font-medium text-muted-foreground"
                >
                  {t('share.urlLabel', { defaultValue: 'Public link' })}
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="share-public-url"
                    readOnly
                    value={shareUrl}
                    onFocus={(event) => event.currentTarget.select()}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCopyUrl()}
                    className="flex-shrink-0 gap-1.5"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-hemi-ok" />
                        {t('codeBlock.copied', { defaultValue: 'Copied' })}
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        {t('codeBlock.copy', { defaultValue: 'Copy' })}
                      </>
                    )}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="share-title-input"
                  className="block text-xs font-medium text-muted-foreground"
                >
                  {t('share.titleLabel', { defaultValue: 'Title' })}
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="share-title-input"
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onBlur={() => void handleSaveTitle()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleSaveTitle();
                      }
                    }}
                    placeholder={t('share.titlePlaceholder', {
                      defaultValue: 'Shared conversation title',
                    })}
                    className="text-sm"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('share.itemsHeading', {
                      defaultValue: 'Messages in shared view',
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('share.itemsVisibleCount', {
                      visible: preview.items.filter((item) => !item.hidden).length,
                      total: preview.items.length,
                      defaultValue: '{{visible}} of {{total}} visible',
                    })}
                  </span>
                </div>

                {preview.items.length === 0 ? (
                  <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
                    {t('share.noItems', {
                      defaultValue: 'No shareable prompts or outputs in this session yet.',
                    })}
                  </div>
                ) : (
                  <div className="max-h-60 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/70 bg-muted/20">
                    {preview.items.map((item) => (
                      <div
                        key={item.id}
                        className={`flex items-start justify-between gap-3 px-3 py-2.5 text-xs transition-opacity ${
                          item.hidden ? 'opacity-50' : ''
                        }`}
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <span className="inline-block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {item.role === 'user'
                              ? t('share.roleUser', { defaultValue: 'Prompt' })
                              : t('share.roleAssistant', { defaultValue: 'Assistant' })}
                          </span>
                          <p className="break-words text-foreground">
                            {truncatePreviewText(item.text)}
                          </p>
                        </div>

                        <button
                          type="button"
                          disabled={togglingId === item.id}
                          onClick={() => void handleToggleItemHidden(item)}
                          aria-label={
                            item.hidden
                              ? t('share.showItem', { defaultValue: 'Show in shared view' })
                              : t('share.hideItem', { defaultValue: 'Hide from shared view' })
                          }
                          title={
                            item.hidden
                              ? t('share.showItem', { defaultValue: 'Show in shared view' })
                              : t('share.hideItem', { defaultValue: 'Hide from shared view' })
                          }
                          className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {item.hidden ? (
                            <>
                              <EyeOff className="h-3.5 w-3.5" />
                              <span>{t('share.hiddenBadge', { defaultValue: 'Hidden' })}</span>
                            </>
                          ) : (
                            <>
                              <Eye className="h-3.5 w-3.5" />
                              <span>{t('share.visibleBadge', { defaultValue: 'Visible' })}</span>
                            </>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-hemi-copper-text hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('share.openSharedView', { defaultValue: 'Open shared view' })}
                </a>

                {confirmingRevoke ? (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmingRevoke(false)}
                    >
                      {t('share.cancelRevoke', { defaultValue: 'Cancel' })}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleRevokeShare()}
                      className="gap-1.5"
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      {t('share.confirmStopSharing', { defaultValue: 'Confirm stop sharing' })}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingRevoke(true)}
                    className="gap-1.5 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('share.stopSharing', { defaultValue: 'Stop sharing' })}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
