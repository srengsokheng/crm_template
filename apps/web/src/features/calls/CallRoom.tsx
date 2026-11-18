import { useEffect, useRef, type ReactNode } from 'react';
import { Copy, Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../lib/cn.ts';
import { Button, Spinner } from '../../components/ui/primitives.tsx';
import { useCallRoom, type Transport } from './useCallRoom.ts';

function Tile({ stream, name, muted, mirrored, note }: { stream: MediaStream | null; name: string; muted?: boolean; mirrored?: boolean; note?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream; }, [stream]);
  const hasVideo = !!stream?.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
  return (
    <figure className="relative aspect-video min-w-0 overflow-hidden rounded-[var(--radius-card)] bg-slate-900" aria-label={name}>
      <video ref={ref} autoPlay playsInline muted={muted} data-peer={name} className={cn('size-full object-cover', mirrored && '-scale-x-100', !hasVideo && 'opacity-0')} />
      {!hasVideo && <div className="absolute inset-0 grid place-items-center text-3xl font-semibold text-white/80" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</div>}
      <figcaption className="absolute bottom-2 left-2 max-w-[85%] truncate rounded bg-black/60 px-2 py-0.5 text-xs text-white">{name}{note ? ` · ${note}` : ''}</figcaption>
    </figure>
  );
}

const STATE_NOTE: Partial<Record<RTCPeerConnectionState, string>> = { new: 'connecting…', connecting: 'connecting…', failed: 'couldn’t connect', disconnected: 'reconnecting…' };

/**
 * The call screen: camera preview and "Join", then the video grid and controls. Used by team members (CallPage) and
 * guests with the link (GuestCallPage).
 */
export function CallRoom({ transport, title, myName, guestUrl, canEnd, onEnd, joinLabel = 'Join call', extra }: {
  transport: Transport; title: string; myName: string; guestUrl?: string | null; canEnd?: boolean; onEnd?: () => Promise<void>; joinLabel?: string; extra?: ReactNode;
}) {
  const room = useCallRoom(transport);
  const copy = async () => {
    if (!guestUrl) return;
    try { await navigator.clipboard.writeText(guestUrl); toast.success('Guest link copied — send it to the customer'); } catch { toast.error('Copy failed — select the link and copy it'); }
  };
  if (room.status === 'ended' || room.status === 'left') {
    return (
      <div className="grid min-h-[50vh] place-items-center text-center">
        <div className="space-y-2">
          <p className="text-lg font-semibold">{room.status === 'ended' ? 'The call has ended' : 'You left the call'}</p>
          {room.status === 'left' && <Button onClick={() => window.location.reload()}>Rejoin</Button>}
        </div>
      </div>
    );
  }
  const preview = room.status === 'preview' || room.status === 'joining' || room.status === 'error';
  const count = room.remotes.length + 1;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="min-w-0 truncate text-lg font-semibold">{title}</h1>
        {guestUrl && <Button size="sm" icon={<Copy className="size-3.5" />} onClick={copy}>Copy guest link</Button>}
      </div>
      {room.mediaProblem && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-100" role="status">{room.mediaProblem}</p>}
      {room.error && <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" role="alert">{room.error}</p>}
      {preview ? (
        <div className="mx-auto w-full max-w-xl space-y-3">
          <Tile stream={room.local} name={`${myName} (you)`} muted mirrored />
          {extra}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Controls room={room} />
            <Button variant="primary" disabled={room.status === 'joining' || !room.local} onClick={() => void room.join()} icon={room.status === 'joining' ? <Spinner className="size-4 text-white" /> : <Video className="size-4" />}>
              {room.status === 'joining' ? 'Joining…' : joinLabel}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={cn('grid gap-2', count === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2', count > 4 && 'lg:grid-cols-3')} aria-label="Participants">
            <Tile stream={room.sharing && room.screen ? new MediaStream([room.screen]) : room.local} name={`${myName} (you)`} muted mirrored={!room.sharing} note={room.sharing ? 'sharing screen' : !room.micOn ? 'muted' : undefined} />
            {room.remotes.map((r) => <Tile key={r.peerId} stream={r.stream} name={r.name} note={STATE_NOTE[r.state]} />)}
          </div>
          {room.remotes.length === 0 && <p className="text-center text-sm text-muted" role="status">Waiting for others to join…{guestUrl ? ' Send the guest link to the customer.' : ''}</p>}
          <div className="sticky bottom-0 flex flex-wrap items-center justify-center gap-2 rounded-[var(--radius-card)] border border-base surface p-2">
            <Controls room={room} />
            {room.canShare && <Button onClick={() => void room.toggleShare()} aria-pressed={room.sharing} icon={<MonitorUp className="size-4" />}>{room.sharing ? 'Stop sharing' : 'Share screen'}</Button>}
            <Button variant="danger" onClick={() => void room.leave()} icon={<PhoneOff className="size-4" />}>Leave</Button>
            {canEnd && onEnd && <Button variant="ghost" onClick={async () => { await onEnd(); }}>End for everyone</Button>}
          </div>
        </>
      )}
    </div>
  );
}

function Controls({ room }: { room: ReturnType<typeof useCallRoom> }) {
  return (
    <>
      <Button onClick={room.toggleMic} disabled={!room.hasMic} aria-pressed={!room.micOn} icon={room.micOn ? <Mic className="size-4" /> : <MicOff className="size-4" />}>{room.micOn ? 'Mute' : 'Unmute'}</Button>
      <Button onClick={room.toggleCam} disabled={!room.hasCam} aria-pressed={!room.camOn} icon={room.camOn ? <Video className="size-4" /> : <VideoOff className="size-4" />}>{room.camOn ? 'Camera off' : 'Camera on'}</Button>
    </>
  );
}
