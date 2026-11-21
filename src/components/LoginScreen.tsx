import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import type { AuthState } from '@shared/types';
import { isWebPlatform } from '@/platform/webBridge';

interface LoginScreenProps {
  auth: AuthState;
  isFullscreen: boolean;
  onLogin: (clientId: string) => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
}

const CLIENT_ID_REGEX = /^[a-f0-9]{32}$/i;

export function LoginScreen({
  auth,
  isFullscreen,
  onLogin,
  onToggleFullscreen,
  onClose,
}: LoginScreenProps) {
  const [clientIdInput, setClientIdInput] = useState(auth.clientId);
  const [showGuide, setShowGuide] = useState(!CLIENT_ID_REGEX.test(auth.clientId));
  const [copiedUri, setCopiedUri] = useState(false);

  useEffect(() => {
    if (auth.clientId && !clientIdInput) {
      setClientIdInput(auth.clientId);
      setShowGuide(false);
    }
  }, [auth.clientId, clientIdInput]);

  const isWeb = isWebPlatform();
  const trimmedId = clientIdInput.trim();
  const isValidId = CLIENT_ID_REGEX.test(trimmedId);
  const redirectUri = auth.redirectUri || 'http://127.0.0.1:43821/callback';

  const handleCopyRedirectUri = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopiedUri(true);
      window.setTimeout(() => setCopiedUri(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidId || auth.isAuthenticating) return;
    onLogin(trimmedId);
  };

  return (
    <div className="login-layer">
      <div className="login-window-bar">
        <div className="glass-pill">
          <button
            className="hud-btn icon-only"
            onClick={onToggleFullscreen}
            title={isFullscreen ? 'Exit Full-Screen (F11)' : 'Full-Screen (F11)'}
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          {!isWeb && (
            <button className="hud-btn icon-only danger" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand-emblem" aria-hidden="true">
          <span className="brand-bar" />
          <span className="brand-bar" />
          <span className="brand-bar" />
          <span className="brand-bar" />
          <span className="brand-bar" />
        </div>

        <div>
          <h1 className="login-title">Spotify Visualizer</h1>
          <p className="login-subtitle">
            Full-screen audio-reactive shaders and real-time synced lyrics driven by your music.
          </p>
        </div>

        <div className="client-id-section">
          <div className="client-id-label-row">
            <label htmlFor="spotify-client-id" className="client-id-label">
              <KeyRound size={13} />
              <span>Spotify Client ID</span>
            </label>
            {trimmedId.length > 0 && (
              <span className={`client-id-status ${isValidId ? 'valid' : 'invalid'}`}>
                {isValidId ? (
                  <>
                    <Check size={12} /> Ready
                  </>
                ) : (
                  `${trimmedId.length}/32 hex chars`
                )}
              </span>
            )}
          </div>

          <input
            id="spotify-client-id"
            type="text"
            className={`client-id-input ${
              trimmedId.length > 0 ? (isValidId ? 'is-valid' : 'is-invalid') : ''
            }`}
            value={clientIdInput}
            onChange={(e) => setClientIdInput(e.target.value)}
            placeholder="Paste your 32-character Client ID"
            spellCheck={false}
            autoComplete="off"
            disabled={auth.isAuthenticating}
          />

          <button
            type="button"
            className="guide-toggle-btn"
            onClick={() => setShowGuide((v) => !v)}
          >
            <span>How to get a Client ID (1 min)</span>
            {showGuide ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {showGuide && (
            <div className="setup-guide">
              <ol className="setup-steps">
                <li>
                  Open the{' '}
                  <button
                    type="button"
                    className="inline-link-btn"
                    onClick={() =>
                      void window.visualizer.window.openExternal(
                        'https://developer.spotify.com/dashboard'
                      )
                    }
                  >
                    Spotify Developer Dashboard <ExternalLink size={11} />
                  </button>{' '}
                  and click <strong>Create app</strong> <em>(requires Spotify Premium)</em>.
                </li>
                <li>
                  Add this exact <strong>Redirect URI</strong>:
                  <div className="uri-copy-row">
                    <code className="uri-code">{redirectUri}</code>
                    <button
                      type="button"
                      className="uri-copy-btn"
                      onClick={() => void handleCopyRedirectUri()}
                    >
                      {copiedUri ? <Check size={13} /> : <Copy size={13} />}
                      <span>{copiedUri ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </li>
                <li>
                  Check <strong>Web API</strong>, click <strong>Save</strong>, then open{' '}
                  <strong>Settings</strong> and paste your <strong>Client ID</strong> above.
                </li>
              </ol>
            </div>
          )}
        </div>

        <button
          type="submit"
          className="spotify-btn"
          disabled={!isValidId || auth.isAuthenticating}
        >
          {auth.isAuthenticating ? (
            <>
              <Loader2 size={18} className="spin" />
              {isWeb ? 'Redirecting to Spotify…' : 'Waiting for Spotify in browser…'}
            </>
          ) : (
            'Connect with Spotify'
          )}
        </button>

        {auth.error && <div className="login-error">{auth.error}</div>}

        <p className="login-footnote">
          Uses secure OAuth PKCE (no Client Secret needed). Your Client ID and session stay stored
          locally {isWeb ? 'in this browser' : 'on your PC'}.
        </p>
      </form>
    </div>
  );
}
