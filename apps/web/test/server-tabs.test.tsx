import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SERVER_TABS, SERVER_TABS_NAV_CLASS } from '@/components/panel/sidebar';

/**
 * Each tab is a route segment typed by hand next to a directory named the same
 * way. A mismatch renders a 404 inside the panel chrome, which looks like the
 * server is broken rather than like a typo.
 */
describe('SERVER_TABS', () => {
  it('covers every section of a server', () => {
    expect(SERVER_TABS.map((tab) => tab.segment)).toEqual([
      '',
      'console',
      'files',
      'backups',
      'schedules',
      'databases',
      'network',
      'sftp',
      'subusers',
      'startup',
      'activity',
      'settings',
    ]);
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
    // A tab missing here is a page with no way to reach it.
    expect(SERVER_TABS.map((tab) => tab.segment)).toEqual([
      '',
      'console',
      'files',
      'backups',
      'schedules',
      'databases',
      'network',
      'sftp',
      'subusers',
      'startup',
      'activity',
      'settings',
    ]);
  });
});
