import { cn } from '@/shared/utils';

type BrandMarkProps = {
  className?: string;
};

/**
 * Fork: the Hemisphere glyph, a circle with its upper half filled. Draws in
 * `currentColor` so it can sit on any container; the standalone assets in
 * `public/` are generated from the same shape by `scripts/fork/generate-brand-icons.mjs`.
 */
export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-4 w-4', className)}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12a9 9 0 0 1 18 0Z" fill="currentColor" stroke="none" />
      <path d="M3 12h18" />
    </svg>
  );
}
