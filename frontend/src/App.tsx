import './styles.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { b64e, dec, deriveAES, enc, genECDH, importPeerPub, newId } from './crypto';

type Msg = { id: string; mine: boolean; text: string; seen: boolean; left: number };
type Status = 'connecting' | 'waiting' | 'secure' | 'reconnecting';
type CallState = 'idle' | 'outgoing' | 'incoming' | 'active';
type CallMode = 'video' | 'voice';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/ws';
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export default function App(): JSX.Element {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Status>('connecting');
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [call, setCall] = useState<CallState>('idle');
  const [callMode, setCallMode] = useState<CallMode>('video');
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const privRef = useRef<CryptoKey | null>(null);
  const seqRef = useRef(1);
  const seenIds = useRef<Set<string>>(new Set());
  const retryRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  const offerRef = useRef<{ sdp: string; mode: CallMode } | null>(null);
  const callTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localVideo = useRef<HTMLVideoElement | null>(null);
  const remoteVideo = useRef<HTMLVideoElement | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const anySeen = msgs.some((m) => m.seen);
    if (!anySeen) return;
    const t = setInterval(() => {
      setMsgs((prev) => prev
        .map((m) => (m.seen ? { ...m, left: m.left - 1 } : m))
        .filter((m) => !m.seen || m.left > 0));
    }, 1000);
    return () => clearInterval(t);
  }, [msgs.some((m) => m.seen)]);
  useEffect(() => { boxRef.current?.scrollTo({ top: 9e6, behavior: 'smooth' }); }, [msgs.length]);

  useEffect(() => {
    if (call !== 'active') { setElapsed(0); return; }
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [call]);

  useEffect(() => {
    const md = navigator.mediaDevices as unknown as Record<string, unknown>;
    if (md?.getDisplayMedia) {
      md.getDisplayMedia = async () => {
        alert('Screen capture is discouraged in this private chat.');
        throw new DOMException('blocked', 'NotAllowedError');
      };
    }
    const clear = (): void => { setMsgs([]); keyRef.current = null; };
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, []);

  const attach = useCallback(() => {
    if (localVideo.current && localRef.current) localVideo.current.srcObject = localRef.current;
    if (remoteRef.current) {
      if (remoteVideo.current) remoteVideo.current.srcObject = remoteRef.current;
      if (remoteAudio.current) remoteAudio.current.srcObject = remoteRef.current;
    }
  }, []);
  useEffect(() => { attach(); }, [call, callMode, attach]);

  const makePC = useCallback((): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (ev) => {
      if (ev.candidate && wsRef.current?.readyState === WebSocket.OPEN)
        wsRef.current.send(JSON.stringify({ t: 'ice', cand: JSON.stringify(ev.candidate) }));
    };
    pc.ontrack = (ev) => { remoteRef.current = ev.streams[0] ?? null; attach(); };
    pcRef.current = pc;
    return pc;
  }, [attach]);

  const endCall = useCallback((signal: boolean) => {
    if (callTimer.current) { clearTimeout(callTimer.current); callTimer.current = null; }
    pcRef.current?.close(); pcRef.current = null;
    localRef.current?.getTracks().forEach((t) => t.stop()); localRef.current = null;
    remoteRef.current = null; offerRef.current = null;
    setCall('idle'); setMuted(false);
    if (signal && wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ t: 'call_end' }));
  }, []);

  const startCall = useCallback(async (mode: CallMode) => {
    if (status !== 'secure' || call !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: mode === 'video', audio: true });
      localRef.current = stream;
      const pc = makePC();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsRef.current?.send(JSON.stringify({ t: 'call_offer', sdp: offer.sdp ?? '', mode }));
      setCallMode(mode); setCall('outgoing');
      callTimer.current = setTimeout(() => endCall(true), 45000);
    } catch { alert('Camera/microphone access denied.'); }
  }, [status, call, makePC, endCall]);

  const acceptCall = useCallback(async () => {
    const off = offerRef.current;
    if (!off) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: off.mode === 'video', audio: true });
      localRef.current = stream;
      const pc = makePC();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      await pc.setRemoteDescription({ type: 'offer', sdp: off.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsRef.current?.send(JSON.stringify({ t: 'call_answer', sdp: answer.sdp ?? '', mode: off.mode }));
      setCallMode(off.mode); setCall('active');
    } catch { endCall(true); alert('Camera/microphone access denied.'); }
  }, [makePC, endCall]);

  const toggleMute = useCallback(() => {
    const tracks = localRef.current?.getAudioTracks() ?? [];
    const next = !muted;
    tracks.forEach((t) => { t.enabled = !next; });
    setMuted(next);
  }, [muted]);

  const connect = useCallback(() => {
    setStatus('connecting');
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    let myPub = '';
    ws.onopen = async () => {
      retryRef.current = 0;
      const { kp, pubB64 } = await genECDH();
      privRef.current = kp.privateKey;
      myPub = pubB64;
      ws.send(JSON.stringify({ t: 'key', pub: pubB64, salt: b64e(crypto.getRandomValues(new Uint8Array(16))) }));
    };
    ws.onmessage = async (ev) => {
      let m: Record<string, string | number | boolean>;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'authed') {
        setStatus((s) => (s === 'secure' ? s : 'waiting'));
      } else if (m.t === 'peer') {
        const online = Boolean(m.online);
        if (!online) { setStatus('waiting'); keyRef.current = null; endCall(false); }
        else if (myPub) ws.send(JSON.stringify({ t: 'key', pub: myPub, salt: b64e(crypto.getRandomValues(new Uint8Array(16))) }));
      } else if (m.t === 'key') {
        try {
          if (!privRef.current) return;
          const peerPub = await importPeerPub(m.pub as string);
          keyRef.current = await deriveAES(privRef.current, peerPub);
          setStatus('secure');
        } catch { /* drop bad keys */ }
      } else if (m.t === 'msg') {
        const id = m.id as string;
        if (seenIds.current.has(id)) return;
        seenIds.current.add(id);
        if (!keyRef.current) return;
        try {
          const text = (await dec(keyRef.current, m.iv as string, m.ct as string)).slice(0, 2000);
          setMsgs((p) => [...p.slice(-99), { id, mine: false, text, seen: false, left: 60 }]);
          ws.send(JSON.stringify({ t: 'seen', id }));
          setTimeout(() => setMsgs((p) => p.map((x) => (x.id === id ? { ...x, seen: true } : x))), 800);
        } catch { /* tampered -> drop */ }
      } else if (m.t === 'seen') {
        setMsgs((p) => p.map((x) => (x.id === m.id ? { ...x, seen: true } : x)));
      } else if (m.t === 'call_offer') {
        if (call !== 'idle') { ws.send(JSON.stringify({ t: 'call_end' })); return; }
        offerRef.current = { sdp: m.sdp as string, mode: (m.mode === 'voice' ? 'voice' : 'video') };
        setCallMode(offerRef.current.mode); setCall('incoming');
      } else if (m.t === 'call_answer') {
        if (callTimer.current) { clearTimeout(callTimer.current); callTimer.current = null; }
        try {
          await pcRef.current?.setRemoteDescription({ type: 'answer', sdp: m.sdp as string });
          setCall('active');
        } catch { endCall(true); }
      } else if (m.t === 'ice') {
        try { await pcRef.current?.addIceCandidate(new RTCIceCandidate(JSON.parse(m.cand as string))); } catch { /* late candidate */ }
      } else if (m.t === 'call_end') {
        endCall(false);
      }
    };
    ws.onclose = () => {
      setStatus('reconnecting');
      keyRef.current = null;
      endCall(false);
      const n = Math.min(1000 * 2 ** retryRef.current++, 15000);
      setTimeout(() => { if (wsRef.current === ws) connect(); }, n);
    };
  }, [call, endCall]);

  useEffect(() => { connect(); }, [connect]);

  const send = async (): Promise<void> => {
    const v = input.trim().slice(0, 2000);
    if (!v || !keyRef.current || wsRef.current?.readyState !== WebSocket.OPEN) return;
    setInput('');
    const id = newId();
    seenIds.current.add(id);
    const { iv, ct } = await enc(keyRef.current, v);
    wsRef.current.send(JSON.stringify({ t: 'msg', id, seq: seqRef.current++, iv, ct }));
    setMsgs((p) => [...p.slice(-99), { id, mine: true, text: v, seen: false, left: 60 }]);
  };

  const secure = status === 'secure';
  const pill = status === 'secure' ? 'pill green' : status === 'waiting' ? 'pill orange' : status === 'reconnecting' ? 'pill red' : 'pill orange';
  const pillText = status === 'secure' ? '● Secure · peer online' : status === 'waiting' ? '○ Waiting for peer…' : status === 'reconnecting' ? '⚠ Reconnecting…' : '○ Connecting…';
  const mm = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <main className="page" onContextMenu={(e) => { if ((e.target as HTMLElement).closest('.bubbles')) e.preventDefault(); }}>
      <header className="top">
        <div className="brand"><span className="logo">◉</span><div><h1>Ping</h1><p>private · ephemeral · 2-person</p></div></div>
        <div className="actions">
          <button className="iconbtn" title="Voice call" disabled={!secure || call !== 'idle'} onClick={() => void startCall('voice')}>📞</button>
          <button className="iconbtn" title="Video call" disabled={!secure || call !== 'idle'} onClick={() => void startCall('video')}>🎥</button>
          <button className="ghost" onClick={() => setShowPrivacy(true)}>🔒 E2E encrypted</button>
          <span className={pill}>{pillText}</span>
        </div>
      </header>

      {call === 'active' && (
        <section className="callbox">
          {callMode === 'video' ? (
            <div className="videos">
              <video ref={remoteVideo} autoPlay playsInline className="remote" />
              <video ref={localVideo} autoPlay playsInline muted className="local" />
            </div>
          ) : (
            <div className="voice"><span className="avatar">◉</span><div><b>Voice call</b><p>{mm} · SRTP encrypted</p></div><audio ref={remoteAudio} autoPlay /></div>
          )}
          <div className="controls">
            <span className="timer">{callMode === 'video' ? `${mm} · SRTP` : '● live'}</span>
            <button className={`roundbtn ${muted ? 'off' : ''}`} onClick={toggleMute}>{muted ? '🔇' : '🎙️'}</button>
            <button className="roundbtn end" onClick={() => endCall(true)}>✕</button>
          </div>
        </section>
      )}
      {call === 'outgoing' && (
        <div className="banner"><span className="pulse" />Calling… waiting for peer to pick up.<button className="roundbtn end sm" onClick={() => endCall(true)}>✕</button></div>
      )}

      {status === 'waiting' && call === 'idle' && (
        <div className="banner"><span className="pulse" />Waiting for someone to open this page… share the URL and you'll be paired automatically.</div>
      )}
      {status === 'reconnecting' && (
        <div className="banner red">Connection lost. Reconnecting — delivery is not guaranteed while offline.</div>
      )}

      <div className="bubbles" ref={boxRef} onCopy={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}>
        {msgs.length === 0 && (
          <div className="empty">
            <div className="empty-title">Say hello 👋</div>
            <div className="empty-sub">Messages are end-to-end encrypted, expire 60s after seen, and are never stored.</div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`row ${m.mine ? 'mine' : 'theirs'}`}>
            <div className="b">{m.text}</div>
            <div className={`meta ${m.seen ? 'seen' : ''}`}>{m.seen ? `Seen · 00:${String(Math.max(0, m.left)).padStart(2, '0')}` : 'Sent'}</div>
          </div>
        ))}
      </div>

      <footer className="composer">
        <input value={input} maxLength={2000} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
          placeholder={secure ? 'Type a message…' : 'Waiting for secure session…'} autoComplete="off" disabled={!secure} />
        <button className="send" onClick={() => void send()} disabled={!secure || !input.trim()}>Send →</button>
      </footer>
      <p className="foot">Best-effort screenshot deterrence only — a browser cannot block cameras or OS capture.</p>

      {call === 'incoming' && (
        <div className="modal">
          <div className="card center">
            <div className="ring">📞</div>
            <h3>Incoming {callMode} call</h3>
            <p>Your peer wants to start a {callMode} call. Media is peer-to-peer SRTP encrypted.</p>
            <div className="modalbtns">
              <button className="send" onClick={() => void acceptCall()}>Accept</button>
              <button className="roundbtn end" onClick={() => endCall(true)}>Decline</button>
            </div>
          </div>
        </div>
      )}
      {showPrivacy && (
        <div className="modal" onClick={() => setShowPrivacy(false)}>
          <div className="card">
            <h3>🔒 End-to-end encrypted</h3>
            <p>Chat messages are encrypted on your device (ECDH P-256 + AES-256-GCM). Calls use peer-to-peer WebRTC with built-in DTLS-SRTP media encryption — the server only relays signaling and cannot decrypt media. P2P calls inherently reveal your IP address to your peer. Nothing is recorded or stored.</p>
          </div>
        </div>
      )}
    </main>
  );
}
