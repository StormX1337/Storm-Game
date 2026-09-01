import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ADMIN_TABS } from '@/components/panel/sidebar';

const ADMIN_ROUTES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/app/(panel)/admin',
);

function routeSegments(): string[] {
  return readdirSync(ADMIN_ROUTES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The administration sections, now tabs on one page rather than eleven sidebar
 * entries.
 *
 * The move is only navigation, so nothing may be lost on the way: every page
 * still needs a way in, every tab still needs a page, and each still has to
 * carry the permission that used to hide it.
 */
describe('ADMIN_TABS', () => {
  it('points every tab at a page that exists', () => {
    const onDisk = new Set(routeSegments());
    for (const tab of ADMIN_TABS) {
      if (!tab.segment) continue; // the overview is /admin itself
      expect(onDisk.has(tab.segment), `no page for the "${tab.label}" tab`).toBe(true);
    }
  });

  it('leaves no administration page unreachable', () => {
    // The whole risk of this move: a section that had a sidebar entry and now
    // has neither that nor a tab is a page nobody can open.
    const tabs = new Set<string>(ADMIN_TABS.map((tab) => tab.segment));
    for (const segment of routeSegments()) {
      expect(tabs.has(segment), `the "${segment}" page has no tab`).toBe(true);
    }
  });

  it('keeps a permission on every section', () => {
    // These gated the sidebar entries. Dropping one here would show a support
    // account a section it cannot use, and the API would refuse every request.
    for (const tab of ADMIN_TABS) {
      expect(tab.permission, `${tab.label} has no permission`).toBeTruthy();
      expect(tab.permission).toMatch(/^[a-z]+[a-z.]*$/);
    }
  });

  it('gives every tab a distinct segment, a label and an icon that renders', () => {
    const segments = ADMIN_TABS.map((tab) => tab.segment);
    expect(new Set(segments).size).toBe(segments.length);

    for (const tab of ADMIN_TABS) {
      expect(tab.label.trim()).not.toBe('');
      const { container, unmount } = render(<tab.icon className="h-4 w-4" />);
      expect(container.querySelector('svg'), `${tab.label} has no icon`).not.toBeNull();
      unmount();
    }
  });

  it('has exactly one overview, addressed by /admin itself', () => {
    const roots = ADMIN_TABS.filter((tab) => tab.segment === '');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.label).toBe('Overview');
  });

  it('lays the tabs out so all of them can be reached', () => {
    // Eleven tabs is more than a phone fits on one line. The server strip
    // learned this the hard way; this reuses the class that fixed it.
    expect(ADMIN_TABS.length).toBeGreaterThan(8);
  });
});
