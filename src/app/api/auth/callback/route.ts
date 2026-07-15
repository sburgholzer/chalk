import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? '';
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? '';
  const redirectUri = `${request.nextUrl.origin}/api/auth/callback`;

  try {
    const response = await fetch(`${domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Token exchange failed:', response.status, errorBody);
      return NextResponse.redirect(new URL(`/login?error=token_exchange_failed`, request.url));
    }

    const data = await response.json();
    const accessToken = data.access_token;
    const idToken = data.id_token;
    const refreshToken = data.refresh_token;

    // Redirect to login page with tokens as query params
    // The client-side AuthProvider will pick them up and store in localStorage
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('access_token', accessToken);
    if (idToken) loginUrl.searchParams.set('id_token', idToken);
    if (refreshToken) loginUrl.searchParams.set('refresh_token', refreshToken);
    return NextResponse.redirect(loginUrl.toString());
  } catch (error) {
    console.error('Token exchange error:', error);
    return NextResponse.redirect(new URL('/login?error=exchange_error', request.url));
  }
}
