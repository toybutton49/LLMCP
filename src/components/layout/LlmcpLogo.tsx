import React from 'react';

/**
 * ============================================================================
 * UNTOUCHED USER LOGO ASSET PATHS
 * - Directly references the exact uploaded JPEG files in /public/assets/logos/
 * - Zero conversion, zero SVG fallback replacement, zero mutation of image files
 * ============================================================================
 */
export const LLMCP_LOGO_ASSET_PATH = '/assets/logos/llmcp-wordmark.jpg';
export const LLMCP_MARK_ASSET_PATH = '/assets/logos/llmcp-octopus.jpg';
export const LLMCP_OCTOPUS_JPG_PATH = '/assets/logos/llmcp-octopus.jpg';
export const LLMCP_WORDMARK_JPG_PATH = '/assets/logos/llmcp-wordmark.jpg';

export interface LlmcpLogoProps {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'mark' | 'wordmark';
  showAssetPreview?: boolean;
  showPhotoPreview?: boolean;
  className?: string;
}

/**
 * Renders the untouched uploaded logos:
 * - '/assets/logos/llmcp-octopus.jpg' for the Octopus Emblem ('mark') in Sidebar & Favicon
 * - '/assets/logos/llmcp-wordmark.jpg' for the legacy LLMCP Text Wordmark
 */
export const LlmcpLogo: React.FC<LlmcpLogoProps> = ({
  size = 'md',
  variant = 'mark',
  showAssetPreview = false,
  showPhotoPreview = false,
  className = ''
}) => {
  // Designer note: Adjust dimensions for the square Octopus emblem ('mark')
  const markDimensions =
    size === 'sm'
      ? 'h-9 w-9'
      : size === 'lg'
        ? 'h-12 w-12'
        : 'h-10 w-10';

  // Designer note: Adjust dimensions for the top-middle Text Wordmark ('wordmark')
  const wordmarkDimensions =
    size === 'lg'
      ? 'h-11 w-36'
      : size === 'sm'
        ? 'h-8 w-28'
        : 'h-9 w-32';

  const useWordmark = variant === 'wordmark' || showAssetPreview || showPhotoPreview;

  return (
    <div className={`inline-flex items-center gap-2 select-none ${className}`}>
      {useWordmark ? (
        <div
          className={`${wordmarkDimensions} inline-flex items-center justify-center rounded-lg border border-zinc-800/90 bg-[#14161f] overflow-hidden shrink-0`}
          title="LLMCP"
        >
          <img
            src={LLMCP_WORDMARK_JPG_PATH}
            alt="LLMCP Text Logo"
            data-testid="llmcp-logo-img"
            className="w-full h-full object-cover object-center"
          />
        </div>
      ) : (
        <div
          className={`${markDimensions} relative flex items-center justify-center rounded-lg border border-zinc-800/90 bg-[#0d0f17] overflow-hidden shrink-0`}
          title="LLMCP"
        >
          <img
            src={LLMCP_OCTOPUS_JPG_PATH}
            alt="LLMCP Octopus Logo"
            data-testid="llmcp-mark-img"
            className="w-full h-full object-contain"
          />
        </div>
      )}
    </div>
  );
};
