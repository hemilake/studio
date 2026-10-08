import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';

import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { AuthProvider, ProtectedRoute } from '@/modules/auth';
import { TaskMasterProvider, TasksSettingsProvider } from '@/modules/task-master';
import { WebSocketProvider } from '@/shared/context/WebSocketContext';
import { PluginsProvider } from '@/modules/plugins';
import { ProjectWorkspaceRoute } from '@/modules/project-workspace';
import { PublicSharePage } from '@/modules/share';
import { i18n } from '@/modules/i18n';
import { detectRouterBasename, resolvePublicShareTokenFromPathname } from '@/shared/utils';

/** Rendered by main.tsx; mounts the shared providers, the auth gate and the project workspace routes. */
export default function App() {
  const routerBasename = detectRouterBasename();
  const publicShareToken = resolvePublicShareTokenFromPathname(
    typeof window !== 'undefined' ? window.location.pathname : '',
    routerBasename,
  );

  // Public share view renders outside AuthProvider, ProtectedRoute, WebSocketProvider,
  // and plugins so opening `/share/:token` never calls authenticated endpoints or opens a WebSocket.
  if (publicShareToken) {
    return (
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <PublicSharePage token={publicShareToken} />
        </ThemeProvider>
      </I18nextProvider>
    );
  }

  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <UiPreferencesProvider>
        <AuthProvider>
          <WebSocketProvider>
            <PluginsProvider>
              <TasksSettingsProvider>
                <TaskMasterProvider>
                <ProtectedRoute>
                  <Router basename={routerBasename}>
                    <Routes>
                      <Route path="/" element={<ProjectWorkspaceRoute />} />
                      <Route path="/session/:sessionId" element={<ProjectWorkspaceRoute />} />
                    </Routes>
                  </Router>
                </ProtectedRoute>
                </TaskMasterProvider>
              </TasksSettingsProvider>
            </PluginsProvider>
          </WebSocketProvider>
        </AuthProvider>
        </UiPreferencesProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
