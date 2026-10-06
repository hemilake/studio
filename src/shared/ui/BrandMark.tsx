import { cn } from '@/shared/utils';

type BrandMarkProps = {
  className?: string;
};

/**
 * Fork: the Hemilake symbol, a copper half disc with an open arc on its left.
 * The arc draws in `currentColor` so it follows the text colour on paper and
 * on ink; the copper half reads `--hemi-copper`. The standalone assets in
 * `public/` are generated from the same shape by `scripts/fork/generate-brand-icons.mjs`.
 */
export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg viewBox="0 0 64 64" className={cn('h-4 w-4', className)} aria-hidden="true">
      <path d="M32 4 A28 28 0 0 1 32 60 Z" className="fill-hemi-copper" />
      <path
        d="M32 4 A28 28 0 0 0 32 60"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
      />
    </svg>
  );
}

type BrandWordmarkProps = {
  className?: string;
};

/**
 * Fork: the product name as a wordmark, lowercase IBM Plex Sans 500 with tight
 * tracking ("hemilake"), followed by "studio" in the muted colour.
 */
export function BrandWordmark({ className }: BrandWordmarkProps) {
  return (
    <span className={cn('whitespace-nowrap font-sans font-medium lowercase tracking-[-0.03em] text-foreground', className)}>
      hemilake <span className="font-normal text-muted-foreground">studio</span>
    </span>
  );
}
