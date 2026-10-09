import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Code2, Copy, Download, FolderDown, Maximize2, MessageSquarePlus, X } from 'lucide-react';

import { useMarkdownWorkspaceProjectId } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { api } from '@/shared/api';
import { useIsDarkMode, useThemeDefinition } from '@/shared/context/ThemeContext';
import { copyTextToClipboard } from '@/shared/utils';
import { loadVisualAssets } from '@/modules/chat/visuals/visualAssets';
import type { VisualAssets } from '@/modules/chat/visuals/visualAssets';
import { buildVisualDocument, parseVisualMeta, SEND_PROMPT_MAX_CHARS, usesD3 } from '@/modules/chat/visuals/visualDocument';
import { buildVisualTheme } from '@/modules/chat/visuals/visualTheme';
import type { VisualTheme } from '@/modules/chat/visuals/visualTheme';
import { useVisualActions, useVisualPending } from '@/modules/chat/visuals/VisualContext';

/**
 * Fork (inline visuals): a ```visual block (or an ```html block's preview)
 * drawn in a sandboxed frame. Contract and threat model: docs/fork/visuals.md.
 */

const MIN_HEIGHT = 48;
// Taller widgets scroll inside the frame, which captures the wheel; keep that rare.
const MAX_INLINE_HEIGHT = 1600;
const DEFAULT_HEIGHT = 240;

/**
 * Last measured height per visual, kept across reloads (localStorage), so a
 * frame mounts at its real size instead of growing from DEFAULT_HEIGHT once it
 * has drawn: a row growing above the viewport is what jerks the transcript
 * while the owner scrolls up. Keyed by the code and the window width (in
 * 200 px steps), since a fluid visual's height depends on its width.
 */
const HEIGHTS_KEY = 'hemi-visual-heights';
const HEIGHTS_MAX = 300;
let heights: Map<string, number> | null = null;

const loadHeights = (): Map<string, number> => {
  if (!heights) {
    heights = new Map();
    try {
      const stored = JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? '[]') as Array<[string, number]>;
      for (const [key, value] of stored) heights.set(key, value);
    } catch {
      // A corrupt entry only costs the first-render size.
    }
  }
  return heights;
};

const hashCode = (code: string): string => {
  // FNV-1a, enough to tell visuals apart; collisions only cost a resize.
  let hash = 0x811c9dc5;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}:${code.length}`;
};

const cacheKey = (code: string): string =>
  `${hashCode(code)}@${typeof window === 'undefined' ? 0 : Math.round(window.innerWidth / 200)}`;

const readHeight = (code: string): number | undefined => loadHeights().get(cacheKey(code));

const writeHeight = (code: string, height: number): void => {
  const map = loadHeights();
  const key = cacheKey(code);
  if (map.get(key) === height) return;
  map.delete(key);
  map.set(key, height);
  while (map.size > HEIGHTS_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  try {
    localStorage.setItem(HEIGHTS_KEY, JSON.stringify([...map]));
  } catch {
    // Storage full or disabled: the in-memory map still serves this page.
  }
};

// Tags that mean something to Studio or to Claude Code when they arrive in a user message.
const RESERVED_TAGS = /<\/?(adversarial_review|system-reminder|files_input|command-name|command-message)[^>]*>/gi;

const slugify = (value: string): string =>
  value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'visual';

function downloadBlob(content: Blob, filename: string): void {
  const url = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The theme and assets a frame needs, resolved after the theme provider has applied its classes. */
function useVisualEnvironment(): { theme: VisualTheme | null; assets: VisualAssets | null; failed: boolean } {
  const themeId = useThemeDefinition().id;
  const isDark = useIsDarkMode();
  const [theme, setTheme] = useState<VisualTheme | null>(null);
  const [assets, setAssets] = useState<VisualAssets | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Child effects run before the provider's, which toggles `.dark` and
    // `data-theme`: read the tokens one frame later.
    const frame = window.requestAnimationFrame(() => setTheme(buildVisualTheme(themeId, isDark)));
    return () => window.cancelAnimationFrame(frame);
  }, [themeId, isDark]);

  useEffect(() => {
    let alive = true;
    loadVisualAssets()
      .then((loaded) => { if (alive) setAssets(loaded); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  return { theme, assets, failed };
}

export type VisualFrameHandle = {
  /** Asks the frame for its biggest SVG (or canvas) as SVG markup or a PNG data URL; null when there is none. */
  exportAs: (format: 'svg' | 'png') => Promise<string | null>;
  /** The standalone document, for Download and Save. */
  documentSource: () => string | null;
};

type VisualFrameProps = {
  code: string;
  title: string;
  /** Full screen: fill the parent instead of sizing to the content. */
  fill?: boolean;
};

export const VisualFrame = forwardRef<VisualFrameHandle, VisualFrameProps>(function VisualFrame({ code, title, fill = false }, ref) {
  const { t } = useTranslation('chat');
  const reactId = useId();
  const frameId = useMemo(() => `v${reactId.replace(/[^a-zA-Z0-9]/g, '')}`, [reactId]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const actions = useVisualActions();
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);
  const { theme, assets, failed } = useVisualEnvironment();
  const [height, setHeight] = useState(() => readHeight(code) ?? DEFAULT_HEIGHT);
  // Keyed by document, so an error from a previous theme's frame is not shown.
  const [scriptError, setScriptError] = useState<{ doc: string; message: string } | null>(null);
  const pendingExports = useRef(new Map<string, (data: string | null) => void>());

  const srcDoc = useMemo(() => {
    if (!theme || !assets) return null;
    return buildVisualDocument({
      code,
      frameId,
      themeCss: theme.css,
      fontCss: assets.fontCss,
      d3Source: usesD3(code) ? assets.d3Source : null,
    });
  }, [assets, code, frameId, theme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      const data = event.data as Record<string, unknown> | null;
      if (!frameWindow || event.source !== frameWindow || !data || data.__hemiVisual !== 1 || data.frame !== frameId) {
        return;
      }
      if (data.type === 'size' && typeof data.height === 'number' && Number.isFinite(data.height)) {
        const next = Math.max(MIN_HEIGHT, Math.ceil(data.height));
        writeHeight(code, next);
        setHeight(next);
      } else if (data.type === 'prompt' && typeof data.text === 'string') {
        const text = data.text.slice(0, SEND_PROMPT_MAX_CHARS).replace(RESERVED_TAGS, '').trim();
        const current = actionsRef.current;
        if (text && current) {
          // Outside bypass Claude still asks before anything risky, so the click
          // sends; in bypass the owner reads the text and presses Enter.
          current.fillComposer(text, current.permissionMode !== 'bypassPermissions');
        }
      } else if (data.type === 'link' && typeof data.href === 'string' && /^https?:\/\//i.test(data.href)) {
        window.open(data.href, '_blank', 'noopener,noreferrer');
      } else if (data.type === 'error' && typeof data.message === 'string') {
        setScriptError({ doc: srcDoc ?? '', message: data.message.slice(0, 300) });
      } else if (data.type === 'export' && typeof data.request === 'string') {
        const resolve = pendingExports.current.get(data.request);
        pendingExports.current.delete(data.request);
        resolve?.(typeof data.data === 'string' ? data.data : null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [code, frameId, srcDoc]);


  useImperativeHandle(ref, () => ({
    exportAs: (format) => new Promise((resolve) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow) {
        resolve(null);
        return;
      }
      const request = `${format}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingExports.current.set(request, resolve);
      frameWindow.postMessage({ __hemiVisualHost: 1, type: 'export', format, request }, '*');
      window.setTimeout(() => {
        if (pendingExports.current.delete(request)) resolve(null);
      }, 5000);
    }),
    documentSource: () => srcDoc,
  }), [srcDoc]);

  if (failed) {
    return <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t('visual.loadFailed', { defaultValue: 'The visual could not be loaded.' })}</div>;
  }
  if (!srcDoc) {
    return <div className="animate-pulse bg-muted/40" style={{ height: fill ? '100%' : height }} />;
  }
  return (
    <>
      <iframe
        ref={iframeRef}
        // A theme change rebuilds the document; the key remounts the frame for it.
        key={theme?.css}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className="block w-full border-0 bg-card"
        style={fill ? { height: '100%' } : { height: Math.min(height, MAX_INLINE_HEIGHT) }}
      />
      {scriptError && scriptError.doc === srcDoc && (
        <div className="border-t border-border px-3 py-1.5 font-mono text-[11px] text-destructive">{scriptError.message}</div>
      )}
    </>
  );
});

function ToolbarButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:text-foreground"
    >
      {children}
    </button>
  );
}

function FullScreenVisual({ code, title, onClose }: { code: string; title: string; onClose: () => void }) {
  const { t } = useTranslation('chat');
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-8" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm">
          <span className="truncate font-medium text-foreground">{title}</span>
          <ToolbarButton label={t('visual.close', { defaultValue: 'Close' })} onClick={onClose}>
            <X className="h-4 w-4" />
          </ToolbarButton>
        </div>
        <div className="min-h-0 flex-1">
          <VisualFrame code={code} title={title} fill />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Opens an ```html block in the same sandboxed frame, full screen. */
export function HtmlPreviewModal({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useTranslation('chat');
  return <FullScreenVisual code={code} title={t('visual.htmlPreview', { defaultValue: 'HTML preview' })} onClose={onClose} />;
}

type VisualBlockProps = {
  code: string;
  /** The fence's info string after the language, e.g. `kind=chart title="Spend by month"`. */
  meta?: string | null;
};

export default function VisualBlock({ code, meta }: VisualBlockProps) {
  const { t } = useTranslation('chat');
  const pending = useVisualPending();
  const actions = useVisualActions();
  const projectId = useMarkdownWorkspaceProjectId();
  const frameRef = useRef<VisualFrameHandle>(null);
  const { kind, title: metaTitle } = useMemo(() => parseVisualMeta(meta), [meta]);
  const title = metaTitle || t('visual.untitled', { defaultValue: 'Visual' });
  const [showCode, setShowCode] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const flash = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus(null), 3000);
  }, []);

  const download = useCallback(async (format: 'html' | 'svg' | 'png') => {
    setMenuOpen(false);
    const base = slugify(metaTitle || kind || 'visual');
    if (format === 'html') {
      const source = frameRef.current?.documentSource();
      if (source) downloadBlob(new Blob([source], { type: 'text/html' }), `${base}.html`);
      return;
    }
    const data = await frameRef.current?.exportAs(format);
    if (!data) {
      flash(t('visual.nothingToExport', { defaultValue: 'This visual has no chart to export as an image.' }));
      return;
    }
    if (format === 'svg') {
      downloadBlob(new Blob([data], { type: 'image/svg+xml' }), `${base}.svg`);
    } else {
      downloadBlob(await (await fetch(data)).blob(), `${base}.png`);
    }
  }, [flash, kind, metaTitle, t]);

  const saveToWorkspace = useCallback(async () => {
    const source = frameRef.current?.documentSource();
    if (!projectId || !source) return;
    const path = `visuals/${slugify(metaTitle || kind || 'visual')}.html`;
    try {
      // The folder may already exist; saving tells us whether it worked.
      await api.createFile(projectId, { path: '', type: 'directory', name: 'visuals' }).catch(() => undefined);
      const response = await api.saveFile(projectId, path, source);
      flash(response.ok
        ? t('visual.saved', { defaultValue: 'Saved to {{path}}', path })
        : t('visual.saveFailed', { defaultValue: 'Could not save the visual.' }));
    } catch {
      flash(t('visual.saveFailed', { defaultValue: 'Could not save the visual.' }));
    }
  }, [flash, kind, metaTitle, projectId, t]);

  if (pending) {
    const lines = code.split('\n').length;
    return (
      <div className="my-3 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="h-2 w-2 animate-pulse rounded-full bg-hemi-copper" />
        <span className="truncate">
          {t('visual.drawing', { defaultValue: 'Drawing {{title}}', title })} · {t('visual.lines', { defaultValue: '{{count}} lines', count: lines })}
        </span>
      </div>
    );
  }

  return (
    <figure className="group/visual my-3 overflow-hidden rounded-xl border border-border bg-card">
      <figcaption className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground">{status ?? title}</span>
        <div className="relative flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/visual:opacity-100">
          {actions && (
            <ToolbarButton
              label={t('visual.askToChange', { defaultValue: 'Ask to change' })}
              onClick={() => actions.fillComposer(t('visual.askToChangePrompt', { defaultValue: 'Update the "{{title}}" visual: ', title }), false)}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </ToolbarButton>
          )}
          <ToolbarButton label={showCode ? t('visual.showVisual', { defaultValue: 'Show visual' }) : t('visual.showCode', { defaultValue: 'Show code' })} onClick={() => setShowCode((value) => !value)}>
            <Code2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label={t('visual.copyCode', { defaultValue: 'Copy code' })} onClick={() => { void copyTextToClipboard(code).then((ok) => ok && flash(t('visual.copied', { defaultValue: 'Code copied' }))); }}>
            <Copy className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label={t('visual.download', { defaultValue: 'Download' })} onClick={() => setMenuOpen((open) => !open)}>
            <Download className="h-3.5 w-3.5" />
          </ToolbarButton>
          {projectId && (
            <ToolbarButton label={t('visual.saveToWorkspace', { defaultValue: 'Save to workspace' })} onClick={() => { void saveToWorkspace(); }}>
              <FolderDown className="h-3.5 w-3.5" />
            </ToolbarButton>
          )}
          <ToolbarButton label={t('visual.fullScreen', { defaultValue: 'Full screen' })} onClick={() => setFullScreen(true)}>
            <Maximize2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-20 min-w-36 overflow-hidden rounded-lg border border-border bg-popover py-1 text-xs shadow-lg" role="menu">
              {(['html', 'svg', 'png'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  role="menuitem"
                  onClick={() => { void download(format); }}
                  className="block w-full px-3 py-1.5 text-left text-popover-foreground hover:bg-muted"
                >
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>
      </figcaption>
      {showCode && (
        <pre className="max-h-[480px] overflow-auto border-t border-border bg-muted/40 px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground">{code}</pre>
      )}
      {/* Hidden, not unmounted, behind the code view: the widget keeps its state and stays exportable. */}
      <div className={showCode ? 'hidden' : 'border-t border-border'}>
        <VisualFrame ref={frameRef} code={code} title={title} />
      </div>
      {fullScreen && <FullScreenVisual code={code} title={title} onClose={() => setFullScreen(false)} />}
    </figure>
  );
}
