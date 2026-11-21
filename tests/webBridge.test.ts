import { describe, expect, it } from 'vitest';
import {
  buildSpotifyAuthorizeUrl,
  getWebRedirectUri,
  isValidSpotifyClientId,
  parseOAuthCallbackParams,
} from '../src/platform/webBridge';
import { pickBestLrclibCandidate } from '../shared/lyricsLookup';

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
});
