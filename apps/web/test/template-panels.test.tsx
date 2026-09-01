import { describe, expect, it } from 'vitest';
import { TEMPLATE_FEATURES, TEMPLATE_FEATURE_INFO, TemplateFeature } from '@storm/types';
import { SERVER_TABS } from '@/components/panel/sidebar';

/**
 * The vocabulary the admin dialog and the server tabs both read.
 *
 * These have to agree: a switch with no tab is a setting that appears to do
 * nothing, and a tab keyed on a feature nobody can turn on is a page nobody
 * reaches. Both were true at some point while this was being built.
 */
describe('optional panels', () => {
  it('describes every feature the switches offer', () => {
    for (const feature of TEMPLATE_FEATURES) {
      const info = TEMPLATE_FEATURE_INFO[feature];
      expect(info, `${feature} has no description`).toBeDefined();
      expect(info.label.trim()).not.toBe('');
      // The description is what an operator decides from, so it has to say
      // more than the label does.
      expect(info.description.length).toBeGreaterThan(40);
    }
  });

  it('gives every feature a tab, and every feature tab a feature', () => {
    const tabFeatures = SERVER_TABS.filter((tab) => 'feature' in tab).map((tab) => tab.feature);

    for (const feature of TEMPLATE_FEATURES) {
      expect(tabFeatures, `${feature} can be switched on but shows nothing`).toContain(feature);
    }
    for (const feature of tabFeatures) {
      expect(
        (TEMPLATE_FEATURES as string[]).includes(feature),
        `the "${feature}" tab is keyed on something no template can declare`,
      ).toBe(true);
    }
  });

  it('keeps the vocabulary and the enum in step', () => {
    expect([...TEMPLATE_FEATURES].sort()).toEqual(Object.values(TemplateFeature).sort());
  });
});
