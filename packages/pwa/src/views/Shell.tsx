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

  if (openId) {
    return (
      <SessionDetail
        key={openId}
        remote={remote}
        ws={ws}
        sessionId={openId}
        title={openTitle}
        live={conn.up && conn.upstream}
        onBack={() => {
          setOpenId(null);
        }}
      />
    );
  }
  return (
    <SessionList
      remote={remote}
      ws={ws}
      onOpen={(id, title) => {
        setOpenId(id);
        setOpenTitle(title);
      }}
    />
  );
}
