import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = ['/login', '/register'];

// A cheap presence check that keeps signed-out visitors off app pages. The API
// validates the session on every request; this only avoids a flash of an
// empty dashboard before the redirect.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!req.cookies.get('fvs_session')) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
