# Spotify Visualizer

A full-screen Windows desktop visualizer that pairs real-time **audio-reactive WebGL2 shaders** (faithfully colored from each song's album artwork and tuned for average-screen-color LED backlights) with **synced lyrics** from Spotify + [LRCLIB](https://lrclib.net/).

> **Disclaimer:** Independent open-source project. Not affiliated with, endorsed by, or sponsored by Spotify AB.

---

## Features

* **4 Calm, Audio-Reactive WebGL2 Styles + Blank Mode (`1`–`5`):**
  1. **Pulse Wash** — Smooth concert wall wash with gentle beat bloom & live FFT curtains
  2. **Bass Eclipse** — High-contrast dark stage with a calm 64-spoke 360° radial FFT halo
  3. **Chromatic Tide** — Edge-to-edge silky dual-tone audio waveform & bass energy tides
  4. **Spectrum Wall** — 48 full-bleed fluid frequency pillars
  5. **Blank** — Clean solid-color background with zero shader motion (great for pure lyrics focus)
* **True Album Cover Colors + Custom Background Color Picker (`C`):** Preserves real jet-black negative space, neutral white/silver, warm gold, and chromatic accents without injecting fake blue/green tints onto dark or black-and-white covers. Choose **Album Cycle**, **Album Lock**, or pick any **Custom Color** (quick swatches, color wheel, or `#HEX` input—with automatic dark-ink contrast on light Blank backgrounds).
* **Native Windows WASAPI Audio Loopback:** Uses a lightweight bundled Windows Core Audio helper (`wasapi-tap.exe`) so real-time audio reactivity works out of the box across stereo speakers, Bluetooth, Dolby Atmos, and **5.1 / 7.1 surround gaming headsets**—with zero screen-capture border and automatic device switching.
* **Adaptive Auto-Gain & Self-Regulating Pulse:** Automatically normalizes volume levels and adjusts beat pulse intensity from chill acoustic songs to heavy drops.
* **Non-Overlapping Album Cover Showcase (`V`):** Optionally displays the album artwork cleanly alongside Focus lyrics, above Cinema subtitles, or centered over pure shaders.
* **Syllable & Word-Synced Lyrics with Letter-by-Letter Sweep & Hop (`L`):** Pulls syllable/word-level timings from **LyricsPlus** (Apple Music / Musixmatch / Spotify catalog) with automatic **LRCLIB** fallback (preferring Enhanced LRC `<mm:ss.xx>` when present). Smooth 60 FPS intra-letter loading-bar fill & jump wave supports **`Sweep: Auto`** *(word-synced tracks, default)*, **`Sweep: All`** *(every synced track)*, and **`Sweep: Off`**, with local caching and per-track `±100ms` timing nudges (`[` / `]`).
* **Built-In Music Controls:** Previous, Play/Pause, and Next controls (`Space`, `←`, `→`) using Spotify's Web API with automatic native Windows media-key fallback.

---

## Quick Start (Download `.exe`)

1. Download the latest portable **`Spotify Visualizer.exe`** from the [Releases page](https://github.com/LasseHartmann/Spotify-Visualizer/releases/latest).
   * *Note:* Because the portable `.exe` is not code-signed, Windows SmartScreen may show a warning on first launch—click **More info → Run anyway** (or build it yourself from source below).
2. Create your own free Spotify Client ID *(takes ~1 minute; Spotify requires an active **Spotify Premium** account to own a Development Mode app)*:
   1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and click **Create app**.
   2. Enter any app name and description.
   3. Under **Redirect URIs**, add this exact URL and click **Add**:
      ```text
      http://127.0.0.1:43821/callback
      ```
   4. Check **Web API**, click **Save**, then open **Settings** and copy your **Client ID**. *(You do **not** need the Client Secret—this app uses OAuth PKCE.)*
3. Launch **`Spotify Visualizer.exe`**, paste your **Client ID**, and click **Connect with Spotify**.
   * Your Client ID and encrypted session token stay stored locally on your PC (`%APPDATA%\spotify-visualizer`).

### Sharing Your Client ID with Friends
Spotify Development Mode allows up to **5 Spotify accounts** per Client ID (your friends do **not** need Spotify Premium):
1. In your [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → **Settings → User Management**, add up to 4 friends' Spotify email addresses.
2. Share `Spotify Visualizer.exe` (or your Vercel link below) and your Client ID with them—they paste it once and sign in with their own Spotify account.

---

## Web App (Deploy on Vercel)

The exact same repository also deploys directly to **Vercel** as a zero-backend static web app (`vercel.json` is preconfigured):

1. Import **`LasseHartmann/Spotify-Visualizer`** in [Vercel](https://vercel.com/new) and click **Deploy** *(no extra settings required—Vercel automatically skips Electron binary downloads and runs `npm run build:web`)*.
2. In your [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → **Settings → Redirect URIs**, add your Vercel callback URL:
   ```text
   https://<your-vercel-domain>/callback
   ```
3. Open your Vercel site, paste your **Client ID**, and click **Connect with Spotify**.
   * *(Optional: to prefill a Client ID for your own private Vercel deployment, add `VITE_SPOTIFY_CLIENT_ID` in Vercel Project Settings → Environment Variables.)*
   * **Browser Audio Note:** In the browser version, click **Ambient** in the top-left pill to enable **Tab / Screen Audio** *(best with Spotify Web Player)* or **Microphone / Line-In**. For automatic system-wide audio across speakers and 5.1/7.1 headsets with zero prompts, use the Windows `.exe`.
   * **Mobile & Amazon Echo Show (Silk) Support:** The web app automatically adapts to phone screens and compact Echo Show displays (`960×480`) and includes a built-in **Keep Awake** (`Awake`) toggle combining the Screen Wake Lock API with a silent keep-alive audio loop (tap the screen once after opening on Echo Show to arm it).
   * **Installable PWA:** Install directly from Chrome, Edge, or Android using the in-app **Install** button (or browser address bar icon), or on iOS Safari via **Share → Add to Home Screen** for a full-screen standalone app experience.

---

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / Pause music |
| `←` / `→` | Previous / Next track |
| `1` – `5` | Switch background style (`Pulse Wash`, `Bass Eclipse`, `Chromatic Tide`, `Spectrum Wall`, `Blank`) |
| `L` | Cycle letter-by-letter sweep (`Auto` / `All` / `Off`) |
| `V` | Show / hide album cover showcase |
| `C` | Cycle color mode (**Album Cycle** / **Album Lock** / **Custom**) |
| `M` | Cycle lyrics mode (`Focus` / `Cinema` / `Off`) |
| `A` | Toggle live Windows audio reactivity |
| `[` / `]` | Nudge lyric sync `-100ms` / `+100ms` (saved per track) |
| `\` | Reset lyric sync offset |
| `F` or `F11` | Toggle full-screen |
| `Esc` | Exit full-screen |
| `H` or `?` | Show shortcut overlay |

---

## Building from Source (Windows)

**Requirements:** Windows 10/11 (x64) and [Node.js 20+](https://nodejs.org/). *(The native WASAPI audio helper compiles automatically using the built-in Windows .NET Framework `csc.exe`—no Visual Studio or Rust install needed.)*

```powershell
git clone https://github.com/LasseHartmann/Spotify-Visualizer.git
cd Spotify-Visualizer
npm install

# Run in development mode
npm run dev

# Run unit tests
npm test

# Package standalone portable release\Spotify Visualizer.exe
npm run dist
```

*(Optional: for a private personal build with a default Client ID prefilled, set `$env:SPOTIFY_CLIENT_ID = "your_32_char_id"` before running `npm run dist`.)*

---

## License

[MIT](./LICENSE) © 2026 Lasse Hartmann
