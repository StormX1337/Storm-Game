import { redirect } from 'next/navigation';

export default function RootPage() {
  // The panel has no marketing surface; the dashboard is the front door and it
  // bounces unauthenticated visitors to sign-in.
  redirect('/dashboard');
}
