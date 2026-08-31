import { describe, expect, it } from 'vitest';

/**
 * Which Docker images the startup tab offers.
 *
 * It used to build the list from the server's own image alone, so the selector
 * had exactly one entry and could not be changed. That is only invisible until
 * it matters: Minecraft raises its minimum Java with the game version and
 * refuses to start on anything older, and the one thing that fixes it —
 * switching image — was the thing the panel would not do.
 */

/** The list the tab builds, extracted so it can be checked without the page. */
function offeredImages(server: {
  dockerImage: string;
  template: { dockerImages: Record<string, string> } | null;
}): { image: string; label: string }[] {
  const declared = server.template?.dockerImages ?? {};
  const byImage = new Map<string, string>();
  for (const [label, image] of Object.entries(declared)) byImage.set(image, label);
  if (!byImage.has(server.dockerImage)) byImage.set(server.dockerImage, server.dockerImage);
  return [...byImage].map(([image, label]) => ({ image, label }));
}

const TEMPLATE = {
  dockerImages: {
    'Java 25': 'eclipse-temurin:25-jre',
    'Java 21': 'eclipse-temurin:21-jre',
    'Java 8': 'eclipse-temurin:8-jre',
  },
};

describe('startup image choices', () => {
  it('offers every image the template declares, not just the one in use', () => {
    const offered = offeredImages({
      dockerImage: 'eclipse-temurin:21-jre',
      template: TEMPLATE,
    });

    expect(offered.map((o) => o.image)).toEqual([
      'eclipse-temurin:25-jre',
      'eclipse-temurin:21-jre',
      'eclipse-temurin:8-jre',
    ]);
    expect(offered.map((o) => o.label)).toContain('Java 25');
  });

  it('keeps showing what is running even after the template drops it', () => {
    // Otherwise the selector would display something the server is not using.
    const offered = offeredImages({
      dockerImage: 'eclipse-temurin:11-jre',
      template: TEMPLATE,
    });

    expect(offered.map((o) => o.image)).toContain('eclipse-temurin:11-jre');
    expect(offered).toHaveLength(4);
  });

  it('does not collapse to a single choice when the template has none', () => {
    const offered = offeredImages({ dockerImage: 'eclipse-temurin:21-jre', template: null });
    expect(offered).toEqual([{ image: 'eclipse-temurin:21-jre', label: 'eclipse-temurin:21-jre' }]);
  });
});
