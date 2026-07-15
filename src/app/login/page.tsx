'use client';

/**
 * Login page for Chalk.
 * Redirects to Cognito hosted UI for authentication.
 * No self sign-up — displays "Contact your administrator for an invitation" message.
 *
 * Requirements: 10.1, 10.6
 */

import { useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';

export function LoginPage() {
  const { isAuthenticated, isLoading, login } = useAuth();

  // Redirect authenticated users to the rooms page
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      window.location.href = '/rooms';
    }
  }, [isAuthenticated, isLoading]);

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50">
        <div className="text-gray-500">Loading...</div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Chalk</h1>
          <p className="mt-2 text-sm text-gray-600">
            Architecture Decision Room
          </p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Sign In</h2>
          <p className="mt-1 text-sm text-gray-500">
            Sign in with your team credentials to access your decision rooms.
          </p>

          <button
            onClick={login}
            className="mt-6 w-full rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-colors"
          >
            Sign in with SSO
          </button>

          <div className="mt-6 border-t border-gray-200 pt-4">
            <p className="text-center text-xs text-gray-500">
              Don&apos;t have an account?
            </p>
            <p className="mt-1 text-center text-xs text-gray-600 font-medium">
              Contact your administrator for an invitation.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

export { LoginPage as default };
