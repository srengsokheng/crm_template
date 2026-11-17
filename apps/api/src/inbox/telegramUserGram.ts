/**
 * The real Telegram user-API driver (GramJS, MTProto). Loaded on first use; tests use a fake (see telegramUser.ts).
 * Messages are sent and read as plain text (no Markdown parsing), so what the team types is what arrives.
 */
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { computeCheck } from 'telegram/Password.js';
import { StringSession } from 'telegram/sessions/index.js';
import { TgUserError, type TgUserDriver, type TgUserIncoming, type TgUserSession } from './telegramUser.ts';

/** GramJS errors carry Telegram's code in errorMessage (FLOOD_WAIT_X → FLOOD_WAIT with seconds). */
function wrap(e: unknown): TgUserError {
  if (e instanceof TgUserError) return e;
  const err = e as { errorMessage?: string; seconds?: number; message?: string };
  const code = err.errorMessage ?? '';
  if (/^FLOOD_WAIT/.test(code) || typeof err.seconds === 'number') return new TgUserError('FLOOD_WAIT', err.message, err.seconds ?? null);
  return new TgUserError(code || 'UNKNOWN', err.message ?? String(e));
}
async function call<T>(fn: () => Promise<T>): Promise<T> { try { return await fn(); } catch (e) { throw wrap(e); } }

const name = (u: { firstName?: string | null; lastName?: string | null; username?: string | null; title?: string | null }) =>
  u.title ?? ([u.firstName, u.lastName].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : ''));

/** "user:<id>:<hash>" / "chat:<id>" / "channel:<id>:<hash>" ⇄ input peers. */
function peerRefOf(entity: Api.User | Api.Chat | Api.Channel): string {
  if (entity instanceof Api.User) return `user:${entity.id.toString()}:${(entity.accessHash ?? bigInt.zero).toString()}`;
  if (entity instanceof Api.Chat) return `chat:${entity.id.toString()}`;
  return `channel:${entity.id.toString()}:${(entity.accessHash ?? bigInt.zero).toString()}`;
}
function inputPeer(ref: string): Api.TypeInputPeer {
  const [kind, id, hash] = ref.split(':');
  if (kind === 'user') return new Api.InputPeerUser({ userId: bigInt(id), accessHash: bigInt(hash ?? '0') });
  if (kind === 'chat') return new Api.InputPeerChat({ chatId: bigInt(id) });
  if (kind === 'channel') return new Api.InputPeerChannel({ channelId: bigInt(id), accessHash: bigInt(hash ?? '0') });
  throw new TgUserError('PEER_ID_INVALID');
}

/** What the Inbox shows for a message and which file it carries; null for service messages. */
function describe(m: Api.Message): { body: string; file: TgUserIncoming['file'] } | null {
  const text = m.message ?? '';
  const cap = text ? ` ${text}` : '';
  const media = m.media;
  if (!media || media instanceof Api.MessageMediaWebPage) return text ? { body: text, file: null } : null;
  if (media instanceof Api.MessageMediaPhoto) return { body: `[Photo]${cap}`, file: { fileName: `photo-${m.id}.jpg`, contentType: 'image/jpeg', size: null } };
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const d = media.document;
    const attr = <T>(cls: new (...a: never[]) => T) => d.attributes.find((a) => a instanceof cls) as T | undefined;
    const fileName = attr(Api.DocumentAttributeFilename)?.fileName;
    const sticker = attr(Api.DocumentAttributeSticker);
    if (sticker) return { body: `[Sticker${sticker.alt ? ` ${sticker.alt}` : ''}]`, file: null };
    const audio = attr(Api.DocumentAttributeAudio);
    const video = attr(Api.DocumentAttributeVideo);
    const label = audio ? '[Audio]' : video ? '[Video]' : `[File: ${fileName ?? 'attachment'}]`;
    const ext = audio?.voice ? 'ogg' : video ? 'mp4' : audio ? 'mp3' : 'bin';
    return { body: `${label}${cap}`, file: { fileName: fileName ?? `${audio?.voice ? 'voice' : video ? 'video' : audio ? 'audio' : 'file'}-${m.id}.${ext}`, contentType: d.mimeType || 'application/octet-stream', size: Number(d.size.toString()) } };
  }
  if (media instanceof Api.MessageMediaGeo && media.geo instanceof Api.GeoPoint) return { body: `[Location: ${media.geo.lat}, ${media.geo.long}]`, file: null };
  if (media instanceof Api.MessageMediaContact) return { body: `[Contact: ${[media.firstName, media.lastName].filter(Boolean).join(' ')} ${media.phoneNumber}]`, file: null };
  if (media instanceof Api.MessageMediaPoll) return { body: `[Poll: ${media.poll.question.text}]`, file: null };
  return { body: text || '[Unsupported message]', file: null };
}

async function toIncoming(m: Api.Message, groups: boolean): Promise<TgUserIncoming | null> {
  if (m.out || !(m instanceof Api.Message)) return null;
  const d = describe(m);
  if (!d) return null;
  const chat = (await m.getChat()) as Api.User | Api.Chat | Api.Channel | undefined;
  if (!chat) return null;
  const isUser = chat instanceof Api.User;
  if (isUser && (chat.bot || chat.self)) return null;
  if (chat instanceof Api.Channel && chat.broadcast) return null; // channels are read-only feeds
  if (!isUser && !groups) return null;
  const sender = (await m.getSender()) as Api.User | Api.Channel | undefined;
  const senderUser = sender instanceof Api.User ? sender : undefined;
  return {
    chatId: isUser ? chat.id.toString() : `-${chat.id.toString()}`, // negative ids for groups, like the Bot API
    chatKind: isUser ? 'direct' : 'group',
    chatTitle: name(chat),
    peerRef: peerRefOf(chat),
    messageId: String(m.id),
    senderName: sender ? name(sender) : '',
    senderUsername: senderUser?.username ?? undefined,
    senderPhone: senderUser?.phone ? `+${senderUser.phone}` : undefined,
    body: d.body,
    file: d.file,
  };
}

function session(client: TelegramClient, apiId: number, apiHash: string): TgUserSession {
  return {
    save: () => (client.session as StringSession).save(),
    sendCode: (phone) => call(async () => {
      const r = await client.sendCode({ apiId, apiHash }, phone);
      return { phoneCodeHash: r.phoneCodeHash };
    }),
    signIn: async (phone, phoneCodeHash, code) => {
      try {
        await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
        return 'ok';
      } catch (e) {
        const w = wrap(e);
        if (w.code === 'SESSION_PASSWORD_NEEDED') return 'password';
        throw w;
      }
    },
    checkPassword: (password) => call(async () => {
      const pwd = await client.invoke(new Api.account.GetPassword());
      await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwd, password) }));
    }),
    me: () => call(async () => {
      const u = await client.getMe();
      return { id: u.id.toString(), username: u.username ?? null, name: name(u), phone: u.phone ? `+${u.phone}` : null };
    }),
    listen: (onMessage, { groups }) => {
      client.addEventHandler(async (ev: NewMessageEvent) => {
        try { const m = await toIncoming(ev.message, groups); if (m) onMessage(m); } catch { /* one bad message must not stop the rest */ }
      }, new NewMessage({ incoming: true }));
    },
    unread: ({ groups }) => call(async () => {
      const out: TgUserIncoming[] = [];
      const dialogs = await client.getDialogs({ limit: 50 });
      for (const d of dialogs) {
        if (!d.unreadCount || !d.entity) continue;
        if (!d.isUser && !groups) continue;
        const msgs = await client.getMessages(d.entity, { limit: Math.min(d.unreadCount, 30) });
        for (const m of msgs.reverse()) {
          const inc = m instanceof Api.Message ? await toIncoming(m, groups) : null;
          if (inc) out.push(inc);
        }
      }
      return out;
    }),
    sendText: (ref, text) => call(async () => String((await client.sendMessage(inputPeer(ref), { message: text, parseMode: false, linkPreview: false })).id)),
    sendFile: (ref, f, caption) => call(async () => {
      const file = new CustomFile(f.fileName, f.data.length, '', f.data);
      const photo = ['image/jpeg', 'image/png', 'image/webp'].includes(f.contentType) && f.data.length <= 10 * 1024 * 1024;
      const m = await client.sendFile(inputPeer(ref), { file, caption, parseMode: false, forceDocument: !photo, workers: 1 });
      return String(m.id);
    }),
    download: (ref, messageId) => call(async () => {
      const [m] = await client.getMessages(inputPeer(ref), { ids: [Number(messageId)] });
      if (!m?.media) return null;
      const data = await client.downloadMedia(m, {});
      return Buffer.isBuffer(data) ? data : null;
    }),
    typing: (ref) => call(async () => { await client.invoke(new Api.messages.SetTyping({ peer: inputPeer(ref), action: new Api.SendMessageTypingAction() })); }),
    logOut: () => call(async () => { await client.invoke(new Api.auth.LogOut()); }),
    close: async () => { await client.destroy(); },
  };
}

export const gramDriver: TgUserDriver = {
  async open(apiId, apiHash, saved) {
    const client = new TelegramClient(new StringSession(saved), apiId, apiHash, {
      connectionRetries: 3, baseLogger: new Logger(LogLevel.NONE), deviceModel: 'CRM Inbox', appVersion: '1.0',
    });
    await call(() => client.connect());
    return session(client, apiId, apiHash);
  },
};
