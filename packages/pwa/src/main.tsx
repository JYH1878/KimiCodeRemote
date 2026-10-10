// kimi-remote PWA entry: pairing key from URL hash (#k=...) or localStorage.
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { keyFromB64url } from './crypto.js';
import { Remote, WsClient } from './api.js';
import { Pairing } from './views/Pairing.js';
import { Shell } from './views/Shell.js';
import './styles.css';

const STORAGE_KEY = 'kimi_remote_key';

function takeKeyFromHash(): string | null {
  if (!location.hash.startsWith('#k=')) return null;
  const k = location.hash.slice(3);
  history.replaceState(null, '', location.pathname + location.search);
  return k;
}

function App() {
  const [invalid, setInvalid] = useState(false);
  const remote = useMemo(() => {
    const fromHash = takeKeyFromHash();
    const raw = fromHash ?? localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const key = keyFromB64url(raw);
      localStorage.setItem(STORAGE_KEY, raw);
      setInvalid(false);
      return new Remote(key);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      setInvalid(true);
      return null;
    }
  }, []);

  if (!remote) return <Pairing invalid={invalid} />;

  const ws = new WsClient(remote);
  ws.start();
  return <Shell remote={remote} ws={ws} />;
}

createRoot(document.getElementById('root')!).render(<App />);
