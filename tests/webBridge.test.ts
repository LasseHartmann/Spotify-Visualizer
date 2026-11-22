import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSpotifyAuthorizeUrl,
  getWebRedirectUri,
  isValidSpotifyClientId,
  parseOAuthCallbackParams,
} from '../src/platform/webBridge';
import { buildSilentWavBytes } from '../src/platform/keepAwake';
import { isIosSafari } from '../src/platform/pwaInstall';
import {
  hasEnhancedWordTags,
  parseDurationStringSec,
  parseLyricsPlusResponse,
  pickBestLrclibCandidate,
} from '../shared/lyricsLookup';

describe('webBridge helpers', () => {
  it('builds a clean /callback Redirect URI from any Vercel or local origin', () => {
    expect(getWebRedirectUri('https://spotify-visualizer.vercel.app')).toBe(
      'https://spotify-visualizer.vercel.app/callback'
    );
    expect(getWebRedirectUri('https://spotify-visualizer.vercel.app/')).toBe(
      'https://spotify-visualizer.vercel.app/callback'
    );
    expect(getWebRedirectUri('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/callback');
  });

  it('builds a valid PKCE Spotify authorize URL with expected scopes', () => {
    const url = buildSpotifyAuthorizeUrl({
      clientId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      redirectUri: 'https://spotify-visualizer.vercel.app/callback',
      state: 'deadbeef1234',
      codeChallenge: 'challenge-xyz',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://accounts.spotify.com');
    expect(parsed.pathname).toBe('/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://spotify-visualizer.vercel.app/callback'
    );
    expect(parsed.searchParams.get('scope')).toContain('user-read-currently-playing');
    expect(parsed.searchParams.get('scope')).toContain('user-modify-playback-state');
  });

  it('parses OAuth callback query parameters accurately', () => {
    expect(parseOAuthCallbackParams('?code=abc123&state=xyz789')).toEqual({
      code: 'abc123',
      state: 'xyz789',
      error: null,
    });
    expect(parseOAuthCallbackParams('?error=access_denied&state=xyz789')).toEqual({
      code: null,
      state: 'xyz789',
      error: 'access_denied',
    });
  });

  it('validates 32-char hexadecimal Spotify Client IDs', () => {
    expect(isValidSpotifyClientId('a1b2c3d4e5f60718293a4b5c6d7e8f90')).toBe(true);
    expect(isValidSpotifyClientId('not-a-valid-id')).toBe(false);
    expect(isValidSpotifyClientId('')).toBe(false);
  });

  it('picks the highest-scoring synced LRCLIB match for normalized titles', () => {
    const best = pickBestLrclibCandidate(
      [
        {
          id: 1,
          trackName: 'Instant Crush',
          artistName: 'Daft Punk',
          duration: 337,
          plainLyrics: 'plain only',
        },
        {
          id: 2,
          trackName: 'Instant Crush (feat. Julian Casablancas)',
          artistName: 'Daft Punk',
          duration: 337,
          syncedLyrics: '[00:08.00] I didn\'t want to be the one to forget',
        },
      ],
      'Instant Crush',
      'Daft Punk',
      337
    );
    expect(best?.id).toBe(2);
  });

  it('prefers Enhanced LRC word-synced entries over standard line-synced LRCLIB entries', () => {
    const best = pickBestLrclibCandidate(
      [
        {
          id: 10,
          trackName: 'Never Gonna Give You Up',
          artistName: 'Rick Astley',
          duration: 213,
          syncedLyrics: '[00:18.89] We\'re no strangers to love',
        },
        {
          id: 11,
          trackName: 'Never Gonna Give You Up',
          artistName: 'Rick Astley',
          duration: 213,
          syncedLyrics: '[00:18.89] <00:18.89>We\'re <00:19.25>no <00:19.53>strangers',
        },
      ],
      'Never Gonna Give You Up',
      'Rick Astley',
      213
    );
    expect(best?.id).toBe(11);
    expect(hasEnhancedWordTags(best?.syncedLyrics)).toBe(true);
  });

  it('parses LyricsPlus word/syllable responses and rejects mismatched durations', () => {
    expect(parseDurationStringSec('5:37.562')).toBeCloseTo(337.562, 2);

    const parsed = parseLyricsPlusResponse(
      'track-1',
      {
        type: 'Word',
        metadata: { source: 'Apple', totalDuration: '3:20.046' },
        lyrics: [
          {
            time: 27395,
            duration: 1565,
            text: 'I been tryna call',
            syllabus: [
              { time: 27395, duration: 154, text: 'I ' },
              { time: 27549, duration: 191, text: 'been ' },
              { time: 27740, duration: 337, text: 'tryna ' },
              { time: 28077, duration: 883, text: 'call' },
            ],
          },
          {
            time: 45000,
            duration: 2000,
            text: 'After break',
            syllabus: [
              { time: 45000, duration: 900, text: 'After ' },
              { time: 45900, duration: 1100, text: 'break' },
            ],
          },
        ],
      },
      200
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.source).toBe('lyricsplus');
    expect(parsed?.hasWordSync).toBe(true);
    // 28960ms -> 45000ms is > 12s gap, so an instrumental break marker is inserted between the 2 lines!
    expect(parsed?.richLines).toHaveLength(3);
    expect(parsed?.richLines?.[1].text).toBe('');
    expect(parsed?.richLines?.[0].words?.[3].endTimeMs).toBe(28960);

    // Reject if totalDuration disagrees wildly (e.g. 9:00 vs 3:20)
    const rejected = parseLyricsPlusResponse(
      'track-1',
      {
        type: 'Word',
        metadata: { source: 'Apple', totalDuration: '9:19.000' },
        lyrics: [{ time: 1000, duration: 1000, text: 'Wrong song' }],
      },
      200
    );
    expect(rejected).toBeNull();
  });

  it('builds a valid 1-second silent PCM WAV buffer for Keep Awake on Amazon Silk / mobile', () => {
    const wav = buildSilentWavBytes(1, 8000);
    expect(wav.byteLength).toBe(8044);
    // Standard RIFF / WAVE header signatures
    expect(String.fromCharCode(wav[0], wav[1], wav[2], wav[3])).toBe('RIFF');
    expect(String.fromCharCode(wav[8], wav[9], wav[10], wav[11])).toBe('WAVE');
    expect(String.fromCharCode(wav[36], wav[37], wav[38], wav[39])).toBe('data');
    // Sample payload is pure unsigned 8-bit silence (128)
    expect(wav[44]).toBe(128);
    expect(wav[wav.byteLength - 1]).toBe(128);
  });

  it('ships a valid standalone PWA manifest with existing PNG icons and detects iOS Safari', () => {
    const publicDir = path.resolve(__dirname, '..', 'public');
    const manifestPath = path.join(publicDir, 'manifest.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      name: string;
      display: string;
      start_url: string;
      icons: Array<{ src: string; sizes: string; type: string }>;
    };

    expect(manifest.name).toBe('Spotify Visualizer');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const rel = icon.src.replace(/^\//, '');
      expect(fs.existsSync(path.join(publicDir, rel))).toBe(true);
    }
    expect(fs.existsSync(path.join(publicDir, 'sw.js'))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, 'icons', 'apple-touch-icon.png'))).toBe(true);

    expect(
      isIosSafari(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
      )
    ).toBe(true);
    expect(
      isIosSafari(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      )
    ).toBe(false);
  });
});
