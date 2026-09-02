import { describe, expect, it } from 'vitest';
import { TEMPLATE_FEATURES } from '@storm/types';
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

  const featureTabs = SERVER_TABS.filter(
    (tab): tab is typeof tab & { feature: string } => 'feature' in tab,
  );

  it('shows each optional tab exactly where its feature is declared', () => {
    // Every feature tab, not two named by hand: the third one was added and
    // this test would have kept passing while saying nothing about it.
    expect(featureTabs.length).toBeGreaterThan(2);

    for (const tab of featureTabs) {
      expect(visibleFor([tab.feature])).toContain(tab.label);
      expect(visibleFor([])).not.toContain(tab.label);
      expect(visibleFor(['something-else'])).not.toContain(tab.label);

      // And it does not come along with somebody else's feature.
      for (const other of featureTabs) {
        if (other.feature === tab.feature) continue;
        expect(visibleFor([other.feature])).not.toContain(tab.label);
      }
    }
  });

  it('names a feature the API actually knows', () => {
    // The string here is matched against what the template stores. A typo
    // hides the tab on every server and looks exactly like a template that
    // has not been given the feature — which is where the last hour goes.
    for (const tab of featureTabs) {
      expect(TEMPLATE_FEATURES, `${tab.label} asks for "${tab.feature}"`).toContain(tab.feature);
    }
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
    expect(always.length).toBe(SERVER_TABS.length - featureTabs.length);
  });

  it('keeps the plugin tab pointed at the route that exists', () => {
    const plugins = SERVER_TABS.find((tab) => tab.label === 'Plugins');
    expect(plugins?.segment).toBe('plugins');
  });
});
