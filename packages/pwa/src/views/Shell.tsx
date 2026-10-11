import { useEffect, useState } from 'react';
import type { Remote, WsClient } from '../api.js';
import { SessionList } from './SessionList.js';
import { SessionDetail } from './SessionDetail.js';

export function Shell({ remote, ws }: { remote: Remote; ws: WsClient }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [openTitle, setOpenTitle] = useState<string>('');
  const [conn, setConn] = useState({ up: false, upstream: false });

  useEffect(() => {
    ws.onStatusChange = () => setConn({ up: ws.transportUp, upstream: ws.upstreamUp });
    setConn({ up: ws.transportUp, upstream: ws.upstreamUp });
    return () => ws.stop();
  }, [ws]);

  // SPA has no router: phone back button / WeChat swipe-back fires popstate.
  // Opening a session pushes a history entry carrying the session id, so both
  // back AND forward restore the right view instead of closing the webview.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = e.state as { view?: string; id?: string; title?: string } | null;
      if (s?.view === 'session' && typeof s.id === 'string') {
        setOpenId(s.id);
        setOpenTitle(s.title ?? '');
      } else {
        setOpenId(null);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openSession = (id: string, title: string) => {
    window.history.pushState({ view: 'session', id, title }, '');
    setOpenId(id);
    setOpenTitle(title);
  };

  const closeSession = () => {
    // keep the stack consistent with what openSession pushed
    if (window.history.state?.view === 'session') window.history.back();
    else setOpenId(null);
  };

  if (openId) {
    return (
      <SessionDetail
        key={openId}
        remote={remote}
        ws={ws}
        sessionId={openId}
        title={openTitle}
        live={conn.up && conn.upstream}
        onBack={closeSession}
      />
    );
  }
  return <SessionList remote={remote} ws={ws} onOpen={openSession} />;
}
