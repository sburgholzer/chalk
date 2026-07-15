'use client';

/**
 * Retry banner displayed when API requests fail with 503 (persistence failures).
 * Provides visual feedback and a dismiss action.
 *
 * Requirements: 9.4, 9.5
 */

export interface RetryBannerProps {
  visible: boolean;
  onDismiss: () => void;
}

export function RetryBanner({ visible, onDismiss }: RetryBannerProps) {
  if (!visible) return null;

  return (
    <div
      role="alert"
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between bg-amber-50 border-b border-amber-200 px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <svg
          className="h-5 w-5 text-amber-600"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
        <p className="text-sm text-amber-800">
          Some changes could not be saved. They will be retried automatically when the connection is restored.
        </p>
      </div>
      <button
        onClick={onDismiss}
        className="ml-4 rounded-md px-2 py-1 text-sm text-amber-700 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
        aria-label="Dismiss notification"
      >
        Dismiss
      </button>
    </div>
  );
}
