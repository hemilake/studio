import React, { useMemo } from 'react';

import type { DiffLine } from '@/shared/types';

type ToolDiffViewerProps = {
  oldContent: string;
  newContent: string;
  filePath: string;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileClick?: () => void;
  badge?: string;
  badgeColor?: 'gray' | 'green';
};

/**
 * Compact diff viewer — VS Code-style.
 *
 * Rendered by chat's ToolRenderer for edit/write tools so a turn's file changes
 * are reviewable inline.
 */
export const ToolDiffViewer: React.FC<ToolDiffViewerProps> = ({
  oldContent,
  newContent,
  filePath,
  createDiff,
  onFileClick,
  badge = 'Diff',
  badgeColor = 'gray'
}) => {
  const badgeClasses = badgeColor === 'green'
    ? 'bg-hemi-ok-tint text-hemi-ok'
    : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400';

  const diffLines = useMemo(
    () => {
      if (oldContent === undefined || newContent === undefined) {
        return [];
      }
      return createDiff(oldContent, newContent)
    },
    [createDiff, oldContent, newContent]
  );

  return (
    <div className="overflow-hidden rounded border border-gray-200/60 dark:border-gray-700/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200/60 bg-gray-50/80 px-2.5 py-1 dark:border-gray-700/50 dark:bg-gray-800/40">
        {onFileClick ? (
          <button
            onClick={onFileClick}
            className="cursor-pointer truncate font-mono text-[11px] text-hemi-copper-text transition-colors"
          >
            {filePath}
          </button>
        ) : (
          <span className="truncate font-mono text-[11px] text-gray-600 dark:text-gray-400">
            {filePath}
          </span>
        )}
        <span className={`rounded px-1.5 py-px text-[10px] font-medium ${badgeClasses} ml-2 flex-shrink-0`}>
          {badge}
        </span>
      </div>

      {/* Diff lines */}
      <div className="font-mono text-[11px] leading-[18px]">
        {diffLines.map((diffLine, i) => (
          <div key={i} className="flex">
            <span
              className={`w-6 flex-shrink-0 select-none text-center ${
                diffLine.type === 'removed'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-hemi-ok-tint text-hemi-ok'
              }`}
            >
              {diffLine.type === 'removed' ? '-' : '+'}
            </span>
            <span
              className={`flex-1 whitespace-pre-wrap px-2 ${
                diffLine.type === 'removed'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-hemi-ok-tint text-hemi-ok'
              }`}
            >
              {diffLine.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
