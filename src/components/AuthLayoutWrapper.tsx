'use client';

/**
 * Client-side wrapper that provides AuthProvider and RetryBanner
 * to the application layout. Needed because the root layout exports
 * Metadata (server component), so auth context must be injected via a client boundary.
 */

import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/components/AuthProvider';
import { RetryBanner } from '@/components/RetryBanner';

function RetryBannerConnected() {
  const { showRetryBanner, dismissRetryBanner } = useAuth();
  return (
    <RetryBanner visible={showRetryBanner} onDismiss={dismissRetryBanner} />
  );
}

export interface AuthLayoutWrapperProps {
  children: ReactNode;
}

export function AuthLayoutWrapper({ children }: AuthLayoutWrapperProps) {
  return (
    <AuthProvider>
      <RetryBannerConnected />
      {children}
    </AuthProvider>
  );
}
