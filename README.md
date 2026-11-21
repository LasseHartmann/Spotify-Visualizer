# Spotify Visualizer

A full-screen Windows desktop visualizer that pairs real-time **audio-reactive WebGL2 shaders** (faithfully colored from each song's album artwork and tuned for average-screen-color LED backlights) with **synced lyrics** from Spotify + [LRCLIB](https://lrclib.net/).

> **Disclaimer:** Independent open-source project. Not affiliated with, endorsed by, or sponsored by Spotify AB.

---

## Features

* **4 Audio-Reactive, Backlight-Optimized WebGL2 Styles (`1`–`4`):**
  1. **Pulse Wash** — Flowing concert wall wash with concentric kick shockwaves & live FFT curtains
  2. **Bass Eclipse** — High-contrast dark stage with a 64-spoke 360° radial FFT ring & explosive beat flares
  3. **Chromatic Tide** — Edge-to-edge living dual-tone audio waveform & bass energy tides
  4. **Spectrum Wall** — 48 full-bleed kinetic frequency pillars
* **True Album Cover Color Fidelity:** Preserves real jet-black negative space, neutral white/silver, warm gold, and chromatic accents without injecting fake blue/green tints onto dark or black-and-white covers. Press `C` to switch between **Album Cycle** and **Color Lock**.
* **Native Windows WASAPI Audio Loopback:** Uses a lightweight bundled Windows Core Audio helper (`wasapi-tap.exe`) so real-time audio reactivity works out of the box across stereo speakers, Bluetooth, Dolby Atmos, and **5.1 / 7.1 surround gaming headsets**—with zero screen-capture border and automatic device switching.
* **Adaptive Auto-Gain & Self-Regulating Pulse:** Automatically normalizes volume levels and adjusts beat pulse intensity from chill acoustic songs to heavy drops.
* **Non-Overlapping Album Cover Showcase (`V`):** Optionally displays the album artwork cleanly alongside Focus lyrics, above Cinema subtitles, or centered over pure shaders.
* **Synced Lyrics via LRCLIB:** Line-synced and enhanced word-synced lyrics with 60 FPS clock interpolation, local caching, and per-track `±100ms` timing nudges (`[` / `]`).
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
2. Share `Spotify Visualizer.exe` and your Client ID with them—they paste it once and sign in with their own Spotify account.

---

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / Pause music |
| `←` / `→` | Previous / Next track |
| `1` – `4` | Switch shader style (`Pulse Wash`, `Bass Eclipse`, `Chromatic Tide`, `Spectrum Wall`) |
| `V` | Show / hide album cover showcase |
| `C` | Toggle **Album Cycle** vs **Color Lock** |
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
