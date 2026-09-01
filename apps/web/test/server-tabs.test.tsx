import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SERVER_TABS, SERVER_TABS_NAV_CLASS } from '@/components/panel/sidebar';

const SERVER_ROUTES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/app/(panel)/servers/[id]',
);

/** The route segments that actually exist on disk under a server. */
function routeSegments(): string[] {
  return readdirSync(SERVER_ROUTES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Each tab is a route segment typed by hand next to a directory named the same
 * way. A mismatch renders a 404 inside the panel chrome, which looks like the
 * server is broken rather than like a typo.
 */
describe('SERVER_TABS', () => {
  it('points every tab at a page that exists', () => {
    const onDisk = new Set(routeSegments());
    for (const tab of SERVER_TABS) {
      if (!tab.segment) continue; // the overview is the bare server URL
      expect(onDisk.has(tab.segment), `no page for the "${tab.label}" tab`).toBe(true);
    }
  });

  it('has one overview tab, addressed by the bare server URL', () => {
    const roots = SERVER_TABS.filter((tab) => tab.segment === '');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.label).toBe('Overview');
  });

  it('gives every tab a distinct segment, a label and an icon that renders', () => {
    const segments = SERVER_TABS.map((tab) => tab.segment);
    expect(new Set(segments).size).toBe(segments.length);

    for (const tab of SERVER_TABS) {
      expect(tab.label.trim(), `${tab.segment || 'overview'} has no label`).not.toBe('');
      // An icon that failed to import is `undefined`, and React only complains
      // about it when someone opens that tab.
      const { container, unmount } = render(<tab.icon className="h-4 w-4" />);
      expect(container.querySelector('svg'), `${tab.label} has no icon`).not.toBeNull();
      unmount();
    }
  });
});

describe('reaching every tab', () => {
  // Twelve tabs held on one line scrolled sideways, and on a phone the four
  // that fit ended flush at the screen edge — so Settings, and the reinstall
  // it holds, could not be found at all. Wrapping is what makes them all
  // reachable, and `min-w-max` is what silently takes that away.
  it('does not force the tabs onto a single line', () => {
    expect(SERVER_TABS_NAV_CLASS).toContain('flex-wrap');
    // Either of these puts the row back on one line, and the tabs past the
    // screen edge back out of reach.
    expect(SERVER_TABS_NAV_CLASS).not.toMatch(/min-w-max/);
    expect(SERVER_TABS_NAV_CLASS).not.toMatch(/flex-nowrap/);
  });

  it('offers every section the panel has', () => {
    // A page with no tab is a page nobody can reach, and until this read the
    // directory it could only compare one hand-written list against another —
    // so it would have said nothing about a route added without a tab.
    const tabs = new Set<string>(SERVER_TABS.map((tab) => tab.segment));
    for (const segment of routeSegments()) {
      expect(tabs.has(segment), `the "${segment}" page has no tab`).toBe(true);
    }
  });
});
