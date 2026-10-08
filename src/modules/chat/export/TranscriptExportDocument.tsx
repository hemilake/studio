import { I18nextProvider } from 'react-i18next';

import { i18n } from '@/modules/i18n';
import type { ChatMessage, DiffLine, LLMProvider, Project } from '@/shared/types';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ActivitySegment, { TurnFooter } from '@/modules/chat/transcript/ActivitySegment';
import AssistantHeader from '@/modules/chat/transcript/AssistantHeader';
import { buildTranscript } from '@/modules/chat/utils/turnSegments';

const noopToggle = () => {};

type TranscriptExportDocumentProps = {
  messages: ChatMessage[];
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  provider: LLMProvider | string;
  selectedProject?: Project | null;
};

/**
 * The transcript, rendered for a document instead of a screen.
 *
 * It deliberately mounts the same `MessageComponent` / `ActivitySegment`
 * tree the chat pane uses. Every previous export was a second formatter that
 * only knew about `msg.type`, which is why tool calls — the bulk of an agent
 * transcript — came out as empty sections. Rendering the real components means
 * the export cannot fall behind the UI: a new tool renderer appears in it for
 * free.
 *
 * Rendered by `buildTranscriptHtml` through `renderToStaticMarkup`, so there
 * are no effects and no interactivity — anything the components hide behind
 * open state is force-shown via `TranscriptRenderContext`.
 */
export function TranscriptExportDocument({
  messages,
  createDiff,
  provider,
  selectedProject,
}: TranscriptExportDocumentProps) {
  // Thinking blocks are included: an export is a record of what happened, and
  // the on-screen toggle is about noise in a live conversation.
  const { items } = buildTranscript(messages, { showThinking: true, isProcessing: false });
  let previousMessage: ChatMessage | null = null;

  return (
    <I18nextProvider i18n={i18n}>
      <TranscriptRenderContext.Provider value={{ isExporting: true }}>
        <div className="chat-export-transcript">
          {items.map((item, index) => {
            if (item.kind === 'turn-footer') {
              return <TurnFooter key={`footer-${index}`} steps={item.steps} durationMs={item.durationMs} />;
            }

            if (item.kind === 'activity') {
              const opensTurn = !previousMessage || (previousMessage.type !== 'assistant' && previousMessage.type !== 'tool');
              previousMessage = item.messages[item.messages.length - 1] || previousMessage;

              // Opened in an export: the folded line hides detail the reader
              // can ask for, and a document has no way to ask.
              return (
                <div key={`activity-${index}`}>
                  {opensTurn && <AssistantHeader kind="assistant" provider={provider} />}
                  <ActivitySegment
                    segment={item}
                    open
                    onToggle={noopToggle}
                    createDiff={createDiff}
                    selectedProject={selectedProject}
                  />
                </div>
              );
            }

            const messagePreviousMessage = previousMessage;
            previousMessage = item.message;

            return (
              <MessageComponent
                key={`message-${index}`}
                message={item.message}
                prevMessage={messagePreviousMessage}
                createDiff={createDiff}
                showRawParameters={false}
                showThinking
                selectedProject={selectedProject}
                provider={provider}
              />
            );
          })}
        </div>
      </TranscriptRenderContext.Provider>
    </I18nextProvider>
  );
}
