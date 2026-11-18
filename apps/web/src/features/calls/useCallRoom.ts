import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A video call in the browser (WebRTC mesh: one connection to each other participant). The server only relays
 * set-up messages; see apps/api/src/calls/calls.ts.
 *
 * Who calls whom: someone joining sends an offer to everyone already there. Every connection has one audio and one
 * video slot from the start, so turning the camera off or sharing the screen only swaps the track (no renegotiation).
 */
export interface Peer { peerId: string; name: string; guest: boolean }
export interface Remote { peerId: string; name: string; stream: MediaStream; state: RTCPeerConnectionState }
export interface Transport {
  join(): Promise<{ peerId: string; secret: string; peers: Peer[]; iceServers: RTCIceServer[] }>;
  eventsUrl(peer: string, secret: string): string;
  signal(body: { peer: string; secret: string; to: string; kind: 'offer' | 'answer' | 'candidate'; data: unknown }): Promise<unknown>;
  leave(body: { peer: string; secret: string }): Promise<unknown>;
}
export type RoomStatus = 'preview' | 'joining' | 'in-call' | 'ended' | 'left' | 'error';

/** Camera and microphone, falling back to microphone only, then to nothing (you can still see and hear others). */
async function getMedia(): Promise<{ stream: MediaStream; problem: string | null }> {
  if (!navigator.mediaDevices?.getUserMedia) return { stream: new MediaStream(), problem: 'This browser can’t use a camera or microphone here (it needs https).' };
  try { return { stream: await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }), problem: null }; }
  catch {
    try { return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }), problem: 'No camera available — joining with sound only.' }; }
    catch { return { stream: new MediaStream(), problem: 'No camera or microphone allowed — others won’t see or hear you. Allow them in the browser’s address bar and rejoin.' }; }
  }
}

export function useCallRoom(transport: Transport) {
  const [status, setStatus] = useState<RoomStatus>('preview');
  const [error, setError] = useState<string | null>(null);
  const [mediaProblem, setMediaProblem] = useState<string | null>(null);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);

  const me = useRef<{ peer: string; secret: string } | null>(null);
  const pcs = useRef(new Map<string, { pc: RTCPeerConnection; stream: MediaStream; pending: RTCIceCandidateInit[] }>());
  const names = useRef(new Map<string, string>());
  const ice = useRef<RTCIceServer[]>([]);
  const es = useRef<EventSource | null>(null);
  const camTrack = useRef<MediaStreamTrack | null>(null);
  const screenTrack = useRef<MediaStreamTrack | null>(null);
  const localRef = useRef<MediaStream | null>(null);

  const refresh = useCallback(() => {
    setRemotes([...pcs.current.entries()].map(([peerId, x]) => ({ peerId, name: names.current.get(peerId) ?? 'Someone', stream: x.stream, state: x.pc.connectionState })));
  }, []);

  // Camera preview before joining.
  useEffect(() => {
    let stop = false;
    void getMedia().then(({ stream, problem }) => {
      if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
      localRef.current = stream;
      camTrack.current = stream.getVideoTracks()[0] ?? null;
      setLocal(stream); setMediaProblem(problem);
      setMicOn(stream.getAudioTracks().length > 0); setCamOn(!!camTrack.current);
    });
    return () => { stop = true; };
  }, []);

  const send = useCallback((to: string, kind: 'offer' | 'answer' | 'candidate', data: unknown) => {
    if (!me.current) return;
    void transport.signal({ ...me.current, to, kind, data }).catch(() => {});
  }, [transport]);

  /** The track this browser sends as video right now (screen while sharing, else the camera if on). */
  const outgoingVideo = () => screenTrack.current ?? (camTrack.current?.enabled ? camTrack.current : null);

  const connection = useCallback((peerId: string, initiator: boolean) => {
    const existing = pcs.current.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: ice.current });
    const entry = { pc, stream: new MediaStream(), pending: [] as RTCIceCandidateInit[] };
    pcs.current.set(peerId, entry);
    if (initiator) { pc.addTransceiver('audio', { direction: 'sendrecv' }); pc.addTransceiver('video', { direction: 'sendrecv' }); attachTracks(pc); }
    pc.onicecandidate = (e) => { if (e.candidate) send(peerId, 'candidate', e.candidate.toJSON()); };
    pc.ontrack = (e) => { entry.stream.addTrack(e.track); refresh(); };
    pc.onconnectionstatechange = () => refresh();
    refresh();
    return entry;
  }, [send, refresh]);

  function attachTracks(pc: RTCPeerConnection) {
    const audio = localRef.current?.getAudioTracks()[0] ?? null;
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      t.direction = 'sendrecv';
      void t.sender.replaceTrack(kind === 'audio' ? audio : outgoingVideo());
    }
  }

  const drop = useCallback((peerId: string) => {
    const x = pcs.current.get(peerId);
    if (!x) return;
    x.pc.close();
    pcs.current.delete(peerId);
    refresh();
  }, [refresh]);

  const onSignal = useCallback(async (from: string, kind: string, data: RTCSessionDescriptionInit & RTCIceCandidateInit) => {
    if (kind === 'offer') {
      const x = connection(from, false);
      await x.pc.setRemoteDescription(data);
      attachTracks(x.pc);
      const answer = await x.pc.createAnswer();
      await x.pc.setLocalDescription(answer);
      send(from, 'answer', { type: answer.type, sdp: answer.sdp });
      for (const c of x.pending.splice(0)) await x.pc.addIceCandidate(c).catch(() => {});
    } else if (kind === 'answer') {
      const x = pcs.current.get(from);
      if (x && x.pc.signalingState === 'have-local-offer') {
        await x.pc.setRemoteDescription(data);
        for (const c of x.pending.splice(0)) await x.pc.addIceCandidate(c).catch(() => {});
      }
    } else if (kind === 'candidate') {
      const x = pcs.current.get(from) ?? connection(from, false);
      if (x.pc.remoteDescription) await x.pc.addIceCandidate(data).catch(() => {});
      else x.pending.push(data);
    }
  }, [connection, send]);

  const cleanup = useCallback(() => {
    es.current?.close(); es.current = null;
    for (const id of [...pcs.current.keys()]) drop(id);
    screenTrack.current?.stop(); screenTrack.current = null;
  }, [drop]);

  const join = useCallback(async () => {
    setStatus('joining'); setError(null);
    try {
      const r = await transport.join();
      me.current = { peer: r.peerId, secret: r.secret };
      ice.current = r.iceServers;
      for (const p of r.peers) names.current.set(p.peerId, p.name);
      const source = new EventSource(transport.eventsUrl(r.peerId, r.secret));
      es.current = source;
      source.addEventListener('peers', (e) => {
        const peers = (JSON.parse((e as MessageEvent<string>).data) as { peers: Peer[] }).peers;
        for (const p of peers) names.current.set(p.peerId, p.name);
        const here = new Set(peers.map((p) => p.peerId));
        for (const id of [...pcs.current.keys()]) if (!here.has(id)) drop(id);
        refresh();
      });
      source.addEventListener('signal', (e) => {
        const s = JSON.parse((e as MessageEvent<string>).data) as { from: string; kind: string; data: RTCSessionDescriptionInit & RTCIceCandidateInit };
        void onSignal(s.from, s.kind, s.data).catch(() => {});
      });
      source.addEventListener('ended', () => { cleanup(); setStatus('ended'); });
      // Call everyone who is already there.
      for (const p of r.peers) {
        const x = connection(p.peerId, true);
        const offer = await x.pc.createOffer();
        await x.pc.setLocalDescription(offer);
        send(p.peerId, 'offer', { type: offer.type, sdp: offer.sdp });
      }
      setStatus('in-call');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus((e as { code?: string }).code === 'CALL_ENDED' ? 'ended' : 'error');
    }
  }, [transport, connection, send, onSignal, cleanup, drop, refresh]);

  const leave = useCallback(async () => {
    const m = me.current;
    cleanup();
    if (m) await transport.leave(m).catch(() => {});
    me.current = null;
    setStatus('left');
  }, [cleanup, transport]);

  // Leaving the page: stop the camera and close the connections (closing the stream also tells the server).
  useEffect(() => () => {
    cleanup();
    localRef.current?.getTracks().forEach((t) => t.stop());
  }, [cleanup]);

  const toggleMic = useCallback(() => {
    const t = localRef.current?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setMicOn(t.enabled);
  }, []);

  const resendVideo = () => {
    for (const { pc } of pcs.current.values()) {
      const tr = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
      void tr?.sender.replaceTrack(outgoingVideo());
    }
  };

  const toggleCam = useCallback(() => {
    const t = camTrack.current;
    if (!t) return;
    t.enabled = !t.enabled;
    setCamOn(t.enabled);
    resendVideo();
  }, []);

  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const toggleShare = useCallback(async () => {
    if (screenTrack.current) {
      screenTrack.current.stop(); screenTrack.current = null; setSharing(false); resendVideo();
      return;
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const t = s.getVideoTracks()[0];
      t.onended = () => { if (screenTrack.current === t) { screenTrack.current = null; setSharing(false); resendVideo(); } };
      screenTrack.current = t;
      setSharing(true);
      resendVideo();
    } catch { /* the person cancelled the picker */ }
  }, []);

  return {
    status, error, mediaProblem, local, remotes, micOn, camOn, sharing, canShare,
    hasMic: !!local?.getAudioTracks().length, hasCam: !!camTrack.current,
    join, leave, toggleMic, toggleCam, toggleShare, screen: sharing ? screenTrack.current : null,
  };
}
