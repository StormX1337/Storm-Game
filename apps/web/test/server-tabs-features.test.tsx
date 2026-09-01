import { describe, expect, it } from 'vitest';
import { SERVER_TABS } from '@/components/panel/sidebar';

/**
 * Which tabs a server shows.
 *
 * A tab carrying a `feature` appears only where the template declares it. The
 * filter lives in the server layout; this pins the data it filters on, because
 * getting it wrong is silent in both directions — a missing plugin browser on
 * Minecraft, or one offered on a Rust server where every call returns 404.
 */
describe('server tabs', () => {
  const visibleFor = (features: string[]) =>
    SERVER_TABS.filter((tab) => !('feature' in tab) || features.includes(tab.feature)).map(
      (tab) => tab.label,
    );

  it('offers the plugin browser only to a template that declares it', () => {
    expect(visibleFor(['plugins'])).toContain('Plugins');
    expect(visibleFor(['players'])).toContain('Players');
    expect(visibleFor(['plugins'])).not.toContain('Players');
    expect(visibleFor([])).not.toContain('Plugins');
    expect(visibleFor(['something-else'])).not.toContain('Plugins');
  });

  it('leaves every other tab alone', () => {
    // The filter must not become a way to lose the standard tabs on a template
    // that declares nothing, which is most of them.
    const always = visibleFor([]);
    for (const label of ['Overview', 'Console', 'Files', 'Backups', 'Settings', 'Startup']) {
      expect(always).toContain(label);
    }
    // Derived, not a number typed by hand: adding a second feature tab broke
    // the hard-coded version, which said nothing about what it meant to check.
    const featureTabs = SERVER_TABS.filter((tab) => 'feature' in tab).length;
    expect(always.length).toBe(SERVER_TABS.length - featureTabs);
  });

  it('keeps the plugin tab pointed at the route that exists', () => {
    const plugins = SERVER_TABS.find((tab) => tab.label === 'Plugins');
    expect(plugins?.segment).toBe('plugins');
  });
});
