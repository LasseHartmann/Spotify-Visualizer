/**
 * Cleans common Spotify track suffixes like "- 2012 Remaster", "(feat. Artist)",
 * "[Deluxe Edition]", etc. so fallback lyrics searches match reliably.
 */
export function normalizeTrackTitle(rawTitle: string): string {
  let title = rawTitle.trim();

  // Remove parenthetical or bracketed featuring / edition / remaster metadata
  title = title.replace(
    /\s*[\(\[](?:(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+|(?:\d{4}\s+)?remaster(?:ed)?[^)\]]*|deluxe[^)\]]*|bonus[^)\]]*|radio\s+edit[^)\]]*|album\s+version|single\s+version|explicit|clean|mono|stereo|live[^)\]]*|acoustic[^)\]]*|anniversary[^)\]]*|[^)\]]*\bversion\b)[\)\]]/gi,
    ''
  );

  // Remove trailing "- Remastered 2015", "- Radio Edit", "- From ...", etc.
  title = title.replace(
    /\s*[-–—]\s*(?:(?:\d{4}\s+)?remaster(?:ed)?.*|radio\s+edit.*|single\s+version.*|album\s+version.*|deluxe.*|from\s+["'“].*|live\s+at.*|mono\s+version.*|stereo\s+version.*|bonus\s+track.*)$/gi,
    ''
  );

  return title.replace(/\s{2,}/g, ' ').trim();
}

export function normalizeForCompare(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
