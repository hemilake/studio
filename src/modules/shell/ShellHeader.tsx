import { RotateCcw, Shield, ShieldOff, X } from 'lucide-react';

type ShellHeaderProps = {
  isConnected: boolean;
  isInitialized: boolean;
  isRestarting: boolean;
  hasSession: boolean;
  sessionDisplayNameShort: string | null;
  onDisconnect: () => void;
  onRestart: () => void;
  statusNewSessionText: string;
  statusInitializingText: string;
  statusRestartingText: string;
  disconnectLabel: string;
  disconnectTitle: string;
  restartLabel: string;
  restartTitle: string;
  disableRestart: boolean;
  showBypassToggle: boolean;
  bypassEnabled: boolean;
  onToggleBypass: () => void;
  bypassLabel: string;
  bypassTitle: string;
};

/** Rendered by Shell above the terminal to show connection status and the restart/disconnect actions. */
export default function ShellHeader({
  isConnected,
  isInitialized,
  isRestarting,
  hasSession,
  sessionDisplayNameShort,
  onDisconnect,
  onRestart,
  statusNewSessionText,
  statusInitializingText,
  statusRestartingText,
  disconnectLabel,
  disconnectTitle,
  restartLabel,
  restartTitle,
  disableRestart,
  showBypassToggle,
  bypassEnabled,
  onToggleBypass,
  bypassLabel,
  bypassTitle,
}: ShellHeaderProps) {
  return (
    <div className="flex-shrink-0 border-b border-gray-700 bg-gray-800 px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-hemi-ok' : 'bg-destructive'}`} />

          {hasSession && sessionDisplayNameShort && (
            <span className="text-xs text-hemi-copper-text">({sessionDisplayNameShort}...)</span>
          )}

          {!hasSession && <span className="text-xs text-gray-400">{statusNewSessionText}</span>}

          {!isInitialized && <span className="text-xs text-hemi-copper-text">{statusInitializingText}</span>}

          {isRestarting && <span className="text-xs text-hemi-copper-text">{statusRestartingText}</span>}
        </div>

        <div className="flex items-center gap-2">
          {showBypassToggle && (
            <button
              type="button"
              onClick={onToggleBypass}
              aria-pressed={bypassEnabled}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 ${
                bypassEnabled
                  ? 'border-hemi-copper/40 bg-hemi-copper text-white hover:bg-hemi-copper/90 focus:ring-hemi-copper/40'
                  : 'border-gray-600/80 bg-gray-700/70 text-gray-100 hover:border-hemi-copper/40 hover:bg-hemi-copper/90 hover:text-white focus:ring-hemi-copper/40'
              }`}
              title={bypassTitle}
            >
              {bypassEnabled ? (
                <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Shield className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{bypassLabel}</span>
            </button>
          )}

          {isConnected && (
            <button
              type="button"
              onClick={onDisconnect}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive px-3 text-xs font-medium text-white transition-colors hover:bg-destructive/90 focus:outline-none focus:ring-2 focus:ring-destructive/40 focus:ring-offset-2 focus:ring-offset-gray-800"
              title={disconnectTitle}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{disconnectLabel}</span>
            </button>
          )}

          <button
            type="button"
            onClick={onRestart}
            disabled={disableRestart}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-600/80 bg-gray-700/70 px-3 text-xs font-medium text-gray-100 transition-colors hover:border-hemi-copper hover:bg-primary/90 hover:text-white focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-gray-800 disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-gray-500 disabled:opacity-60"
            title={restartTitle}
          >
            <RotateCcw className={`h-3.5 w-3.5 ${isRestarting ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{restartLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
