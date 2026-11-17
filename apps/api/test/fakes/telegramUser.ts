/**
 * A fake Telegram user API for tests (and the e2e server). Accounts by phone:
 *   +85512345678  "Sreng" (@sreng_sales), no two-step verification
 *   +85511111111  "Bopha", two-step verification password "correct horse"
 *   anything else → PHONE_NUMBER_INVALID. api_id 1 → API_ID_INVALID. The login code is always 12345.
 * Sessions are strings: "sent:<phone>" after sendCode, "pw:<phone>" waiting for the password, "ok:<phone>" signed in.
 */
import { TgUserError, type TgUserDriver, type TgUserIncoming, type TgUserSession } from '../../src/inbox/telegramUser.ts';

const ACCOUNTS: Record<string, { id: string; username: string | null; name: string; password?: string }> = {
  '+85512345678': { id: '501', username: 'sreng_sales', name: 'Sreng' },
  '+85511111111': { id: '502', username: null, name: 'Bopha', password: 'correct horse' },
};

export function fakeTelegramUser(opts: { greetAfterLogin?: TgUserIncoming } = {}) {
  const state = {
    sent: [] as { phone: string; peerRef: string; text?: string; file?: { fileName: string; size: number }; caption?: string }[],
    typing: [] as { phone: string; peerRef: string }[],
    files: new Map<string, Buffer>(),
    unread: new Map<string, TgUserIncoming[]>(),
    listeners: new Map<string, ((m: TgUserIncoming) => void)[]>(),
    revoked: new Set<string>(),
    loggedOut: [] as string[],
    open: 0,
    nextId: 9000,
  };
  const phoneOf = (s: string) => s.split(':')[1] ?? '';
  const driver: TgUserDriver = {
    async open(apiId, _apiHash, saved) {
      state.open++;
      let cur = saved;
      let mine: ((m: TgUserIncoming) => void) | null = null;
      const signedIn = () => {
        if (!cur.startsWith('ok:')) throw new TgUserError('AUTH_KEY_UNREGISTERED');
        if (state.revoked.has(phoneOf(cur))) throw new TgUserError('AUTH_KEY_UNREGISTERED');
        return phoneOf(cur);
      };
      if (cur.startsWith('ok:') && state.revoked.has(phoneOf(cur))) throw new TgUserError('AUTH_KEY_UNREGISTERED');
      const s: TgUserSession = {
        save: () => cur,
        async sendCode(phone) {
          if (apiId === 1) throw new TgUserError('API_ID_INVALID');
          if (!ACCOUNTS[phone]) throw new TgUserError('PHONE_NUMBER_INVALID');
          cur = `sent:${phone}`;
          return { phoneCodeHash: `hash-${phone}` };
        },
        async signIn(phone, hash, code) {
          if (!cur.startsWith('sent:') || hash !== `hash-${phone}`) throw new TgUserError('PHONE_CODE_EXPIRED');
          if (code !== '12345') throw new TgUserError('PHONE_CODE_INVALID');
          if (ACCOUNTS[phone].password) { cur = `pw:${phone}`; return 'password'; }
          cur = `ok:${phone}`;
          return 'ok';
        },
        async checkPassword(pw) {
          const phone = phoneOf(cur);
          if (!cur.startsWith('pw:')) throw new TgUserError('AUTH_KEY_UNREGISTERED');
          if (ACCOUNTS[phone].password !== pw) throw new TgUserError('PASSWORD_HASH_INVALID');
          cur = `ok:${phone}`;
        },
        async me() { const a = ACCOUNTS[signedIn()]; return { id: a.id, username: a.username, name: a.name, phone: signedIn() }; },
        listen(onMessage) {
          const phone = signedIn();
          mine = onMessage;
          state.listeners.set(phone, [...(state.listeners.get(phone) ?? []), onMessage]);
          if (opts.greetAfterLogin) setTimeout(() => onMessage(opts.greetAfterLogin!), 500);
        },
        async unread() { const phone = signedIn(); const u = state.unread.get(phone) ?? []; state.unread.delete(phone); return u; },
        async sendText(peerRef, text) {
          const phone = signedIn();
          if (peerRef.startsWith('user:999:')) throw new TgUserError('USER_IS_BLOCKED');
          if (peerRef.startsWith('user:998:')) throw new TgUserError('FLOOD_WAIT', 'wait', 30);
          state.sent.push({ phone, peerRef, text });
          return String(state.nextId++);
        },
        async sendFile(peerRef, f, caption) {
          const phone = signedIn();
          state.sent.push({ phone, peerRef, file: { fileName: f.fileName, size: f.data.length }, caption });
          return String(state.nextId++);
        },
        async download(_peerRef, messageId) { signedIn(); return state.files.get(messageId) ?? null; },
        async typing(peerRef) { state.typing.push({ phone: signedIn(), peerRef }); },
        async logOut() { state.loggedOut.push(phoneOf(cur)); },
        async close() { if (mine) for (const [k, ls] of state.listeners) state.listeners.set(k, ls.filter((l) => l !== mine)); },
      };
      return s;
    },
  };
  /** Delivers a message to the live connection(s) of an account. */
  const deliver = (phone: string, m: TgUserIncoming) => { for (const l of state.listeners.get(phone) ?? []) l(m); };
  return { driver, state, deliver };
}

export const incoming = (over: Partial<TgUserIncoming> & { messageId: string }): TgUserIncoming => ({
  chatId: '7001', chatKind: 'direct', chatTitle: 'Sok Dara', peerRef: 'user:7001:123456789', senderName: 'Sok Dara',
  senderUsername: 'sokdara', body: 'Hello', file: null, ...over,
});
