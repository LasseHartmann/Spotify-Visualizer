declare const __DEFAULT_SPOTIFY_CLIENT_ID__: string | undefined;

const bakedClientId =
  typeof __DEFAULT_SPOTIFY_CLIENT_ID__ === 'string'
    ? __DEFAULT_SPOTIFY_CLIENT_ID__.trim()
    : '';

export const SPOTIFY_CONFIG = {
  /**
   * Optional build-time default Client ID (empty in public GitHub builds so each user
   * enters their own Spotify Client ID directly inside the app).
   */
  defaultClientId: bakedClientId || (process.env.SPOTIFY_CLIENT_ID ?? '').trim(),
  redirectHost: '127.0.0.1',
  redirectPort: 43821,
  redirectPath: '/callback',
  redirectUri: 'http://127.0.0.1:43821/callback',
  scopes: [
    'user-read-currently-playing',
    'user-read-playback-state',
    'user-modify-playback-state',
  ].join(' '),
  authorizeUrl: 'https://accounts.spotify.com/authorize',
  tokenUrl: 'https://accounts.spotify.com/api/token',
  apiBaseUrl: 'https://api.spotify.com/v1',
} as const;

export function isValidSpotifyClientId(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value.trim());
}
