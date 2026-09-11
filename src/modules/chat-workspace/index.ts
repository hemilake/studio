export { ChatShortcut, ChatShortcutRailButton } from '@/modules/chat-workspace/ChatShortcut';
export {
  DEFAULT_CHAT_WORKSPACE_MODEL,
  fetchDefaultChatWorkspacePath,
  isChatWorkspaceProject,
  readChatWorkspaceModelPreference,
  readChatWorkspacePreference,
  writeChatWorkspaceModelPreference,
  writeChatWorkspacePreference,
} from '@/modules/chat-workspace/chatWorkspace';
export { useChatWorkspaceModel } from '@/modules/chat-workspace/useChatWorkspaceModel';
export { useOpenChat, useOpenChatShortcut, OPEN_CHAT_SHORTCUT_LABEL } from '@/modules/chat-workspace/useOpenChat';
export type { OpenChatState } from '@/modules/chat-workspace/useOpenChat';
