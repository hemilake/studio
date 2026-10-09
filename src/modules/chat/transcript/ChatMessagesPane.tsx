import { useTranslation } from 'react-i18next';
import { memo, useCallback, useMemo, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { ChatMessage,
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { buildTranscript } from '@/modules/chat/utils/turnSegments';
import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import ActivitySegment, { LiveLine, TurnFooter } from '@/modules/chat/transcript/ActivitySegment';
import AssistantHeader from '@/modules/chat/transcript/AssistantHeader';
import LoadAllMessagesOverlay from '@/modules/chat/transcript/LoadAllMessagesOverlay';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';
import { SessionShareDialog } from '@/modules/share';

/**
 * How many of the newest rows mount with real content on the first commit,
 * before the lazy-row observer has had a chance to report what is actually
 * near the viewport. Covers a bit more than one screen of typical rows.
 */
const INITIAL_MOUNTED_TAIL_ROWS = 30;

/**
 * Fork: how many rows that "load earlier" prepends right above the old first
 * row mount with real content on their first commit. They land next to (often
 * inside) the viewport; as placeholders they mounted a frame later and swapped
 * 100 px estimates for their real height on screen, which browser scroll
 * anchoring cannot correct when the changing rows are the visible ones. Rows
 * with inline visuals (often 600-1,200 px) made it a jerk of ~900 px while
 * scrolling up. "Load all" still prepends placeholders beyond this band.
 */
const PREPENDED_MOUNTED_ROWS = 20;

/** A folded activity line, for the placeholder of a segment never measured. */
const ACTIVITY_ROW_HEIGHT_PX = 32;

type ChatMessagesPaneProps = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** The provider's status line for the running turn, shown on the live line when no tool runs. */
  liveStatusText?: string | null;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /** Loads an already-sent message back into the composer; absent when the provider cannot re-run from a point. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Branches the conversation into a new session ending at a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
  /** Fetches the whole transcript for an export, which otherwise only sees the loaded page. */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
};

/**
 * Rendered by chat's ChatInterface as the scrolling transcript: the message
 * list and tool groups, the export menu, the provider empty state and the
 * load-all-history overlay.
 */
function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  liveStatusText = null,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onEditMessage,
  onForkFromMessage,
  onLoadFullTranscript,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  // Fork (Hemilake Studio activity): text blocks, activity segments (a run of
  // tool calls between two sentences, folded into one line) and turn footers,
  // plus the one live line of a running turn.
  const transcript = useMemo(
    () => buildTranscript(visibleMessages, { showThinking: Boolean(showThinking), isProcessing }),
    [visibleMessages, showThinking, isProcessing],
  );

  // Open or folded, per segment, as the user left it; ActivitySegment opens
  // one with a failed step until the user says otherwise.
  const [openSegments, setOpenSegments] = useState<Record<string, boolean>>({});
  const toggleSegment = useCallback((id: string, open: boolean) => {
    setOpenSegments((current) => ({ ...current, [id]: open }));
  }, []);

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // A server refresh can replace source records with equivalent new objects, so
  // object identity is not a durable React key across pagination or hydration.
  // Deriving keys from this render's ordered messages (intrinsic key,
  // disambiguated by occurrence index on collision) preserves existing DOM
  // nodes and component state when older history is prepended.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of transcript.items) {
      if (item.kind === 'activity') {
        item.messages.forEach(assign);
      } else if (item.kind === 'message') {
        assign(item.message);
      }
    }
    return keys;
  }, [transcript]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  const rowKeyOf = useCallback((item: (typeof transcript.items)[number]) => {
    if (item.kind === 'turn-footer') return item.id;
    if (item.kind === 'activity') return `activity-${getMessageKey(item.messages[0])}`;
    return getMessageKey(item.message);
  }, [getMessageKey]);

  // Fork: which rows were just prepended above the rows already shown (see
  // PREPENDED_MOUNTED_ROWS). Matched by "first row that was already there",
  // not by the old first key: the first activity segment often merges with
  // the tool calls a page adds before it and changes key. Adjusted during
  // render, React's pattern for state derived from the previous render, so
  // the new rows mount in the same pass.
  const rowKeys = useMemo(() => transcript.items.map(rowKeyOf), [transcript.items, rowKeyOf]);
  const [previousRowKeys, setPreviousRowKeys] = useState<ReadonlySet<string>>(() => new Set(rowKeys));
  const [prependedRows, setPrependedRows] = useState<{ from: number; to: number } | null>(null);
  if (rowKeys.length > 0 && !previousRowKeys.has(rowKeys[0]) && previousRowKeys.size > 0) {
    const firstKnown = rowKeys.findIndex((key) => previousRowKeys.has(key));
    setPreviousRowKeys(new Set(rowKeys));
    setPrependedRows(firstKnown > 0
      ? { from: Math.max(0, firstKnown - PREPENDED_MOUNTED_ROWS), to: firstKnown }
      : null);
  } else if (rowKeys.length > 0 && rowKeys[rowKeys.length - 1] !== [...previousRowKeys].pop()) {
    // Appended rows (a new turn) or a different session: remember the keys,
    // nothing to mount early (the tail rows mount anyway).
    setPreviousRowKeys(new Set(rowKeys));
  }

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3 pt-3 sm:pb-4 sm:pt-4"
    >
      {chatMessages.length > 0 && (
        <div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex justify-end sm:px-4">
          <div className="pointer-events-auto flex items-center gap-1.5">
            {(selectedSession?.id || currentSessionId) && (
              <SessionShareDialog
                sessionId={(selectedSession?.id || currentSessionId) as string}
                sessionTitle={selectedSession?.summary || selectedSession?.title}
                provider={provider}
              />
            )}
            <ChatExportMenu
              messages={chatMessages}
              sessionTitle={selectedSession?.summary || selectedSession?.title}
              provider={provider}
              selectedProject={selectedProject}
              createDiff={createDiff}
              onLoadFullTranscript={onLoadFullTranscript}
            />
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4">
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          providerModels={providerModels}
          setProviderModel={setProviderModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-gray-500 dark:text-gray-400">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </div>
          )}

          <LoadAllMessagesOverlay
            showLoadAllOverlay={showLoadAllOverlay}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            totalMessages={totalMessages}
            onLoadAllMessages={loadAllMessages}
          />

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-hemi-copper-text underline" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-hemi-copper-text underline"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {(() => {
            let prevMessage: ChatMessage | null = null;
            const { items, live } = transcript;
            const rowCount = items.length;
            // An assistant turn names its provider once, over its first block.
            const opensTurn = (previous: ChatMessage | null) =>
              !previous || (previous.type !== 'assistant' && previous.type !== 'tool');
            const shortTime = (timestamp: ChatMessage['timestamp']) =>
              new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const rows = items.map((item, index) => {
              // Rows near the tail mount their content on first commit so the
              // initial scroll-to-bottom measures real heights; older rows
              // start as placeholders and mount when scrolled toward.
              const initiallyNearViewport = index >= rowCount - INITIAL_MOUNTED_TAIL_ROWS
                || (prependedRows !== null && index >= prependedRows.from && index < prependedRows.to);

              if (item.kind === 'turn-footer') {
                return <TurnFooter key={item.id} steps={item.steps} durationMs={item.durationMs} />;
              }

              if (item.kind === 'activity') {
                const showHeader = opensTurn(prevMessage);
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;

                return (
                  <LazyMessageRow
                    key={`activity-${getMessageKey(item.messages[0])}`}
                    lazyRows={lazyRows}
                    timestamp={item.timestamp}
                    initiallyNearViewport={initiallyNearViewport}
                    estimatedHeight={ACTIVITY_ROW_HEIGHT_PX}
                  >
                    <div className="px-3 sm:px-0">
                      {showHeader && <AssistantHeader kind="assistant" provider={provider} time={shortTime(item.timestamp)} />}
                      <ActivitySegment
                        segment={item}
                        open={openSegments[item.id]}
                        onToggle={toggleSegment}
                        live={live && live.segmentId === item.id ? live : null}
                        liveStatusText={liveStatusText}
                        createDiff={createDiff}
                        onFileOpen={onFileOpen}
                        selectedProject={selectedProject}
                      />
                    </div>
                  </LazyMessageRow>
                );
              }

              const message = item.message;
              const messagePrevMessage = prevMessage;
              prevMessage = message;

              return (
                <LazyMessageRow
                  key={getMessageKey(message)}
                  lazyRows={lazyRows}
                  timestamp={message.timestamp}
                  initiallyNearViewport={initiallyNearViewport}
                >
                  <MessageComponent
                    message={message}
                    prevMessage={messagePrevMessage}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                    onEditMessage={onEditMessage}
                    onForkFromMessage={onForkFromMessage}
                  />
                </LazyMessageRow>
              );
            });

            // The running turn's live line, when it does not belong to a
            // trailing segment: between a sentence and the next step, or
            // before the first one.
            if (live && !live.segmentId) {
              const showHeader = opensTurn(prevMessage);
              rows.push(
                <div key="activity-live" className="px-3 sm:px-0">
                  {showHeader && <AssistantHeader kind="assistant" provider={provider} />}
                  <div className="ml-0.5 border-l-2 border-hemi-copper/40 pl-3">
                    <LiveLine live={live} statusText={liveStatusText} />
                  </div>
                </div>,
              );
            }

            return rows;
          })()}
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
