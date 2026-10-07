import { useThemeDefinition } from '@/shared/context/ThemeContext';
import type { BrandMarkSize } from '@/shared/theme/registry';

/**
 * Fork: the active theme's mark (Hemilake symbol, Orange logo, CloudCLI bubble).
 * `size="large"` lets a theme switch to its full logo on auth screens.
 */
export function BrandMark({ className, size }: { className?: string; size?: BrandMarkSize }) {
  const { Mark } = useThemeDefinition();
  return <Mark className={className} size={size} />;
}

/** Fork: the active theme's wordmark, shown next to BrandMark. */
export function BrandWordmark({ className }: { className?: string }) {
  const { Wordmark } = useThemeDefinition();
  return <Wordmark className={className} />;
}

/** Fork: the active theme's product name, for labels and titles. */
export function useBrandName(): string {
  return useThemeDefinition().brandName;
}
