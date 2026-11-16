/*
 * Acme CRM website chat. Add to any page:
 *   <script src="https://YOUR-CRM/widget.js" data-key="CHANNEL_KEY" async></script>
 * Messages go to the CRM Inbox; replies appear here (checked every few seconds while the chat is open).
 * Everything lives in a shadow root, so the page's CSS can't break it and it can't break the page.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__crmChat) return;
  window.__crmChat = true;
  var key = script.getAttribute('data-key');
  if (!key) return;
  var api = new URL(script.src).origin + '/api/v1/public/webchat/' + encodeURIComponent(key);
  var store = 'crmchat:' + key;
  var token = null;
  try { token = localStorage.getItem(store); } catch { /* storage blocked: the chat lasts until reload */ }

  function request(method, path, body) {
    return fetch(api + path, {
      method: method,
      headers: body ? { 'content-type': 'application/json', 'x-requested-with': 'crm' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  }

  request('GET', '').then(start, function () { /* channel disabled or unknown: show nothing */ });

  function start(settings) {
    var host = document.createElement('div');
    host.setAttribute('data-crm-chat', '');
    var root = host.attachShadow({ mode: 'open' });
    var color = /^#[0-9a-f]{6}$/i.test(settings.color) ? settings.color : '#4f46e5';
    root.innerHTML = '<style>' +
      ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
      '.btn{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;background:' + color + ';color:#fff;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);display:grid;place-items:center;z-index:2147483646}' +
      '.btn:focus-visible,.send:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px ' + color + '}' +
      '.panel{position:fixed;right:20px;bottom:88px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:var(--bg);color:var(--fg);border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:2147483647;--bg:#fff;--fg:#111827;--muted:#6b7280;--bubble:#f3f4f6;--line:#e5e7eb}' +
      '@media (prefers-color-scheme:dark){.panel{--bg:#1f2937;--fg:#f9fafb;--muted:#9ca3af;--bubble:#374151;--line:#4b5563}}' +
      '@media (max-width:480px){.panel{right:16px;left:16px;width:auto;max-width:none;bottom:84px;height:calc(100vh - 110px)}}' +
      '.open{display:flex}.head{background:' + color + ';color:#fff;padding:14px 16px;font-weight:600;font-size:15px;display:flex;justify-content:space-between;align-items:center}' +
      '.x{background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}' +
      '.list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}' +
      '.m{max-width:80%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
      '.in{align-self:flex-end;background:' + color + ';color:#fff;border-bottom-right-radius:4px}.out{align-self:flex-start;background:var(--bubble);border-bottom-left-radius:4px}' +
      '.who{font-size:11px;color:var(--muted);margin:2px 4px -4px}.form{border-top:1px solid var(--line);padding:10px;display:flex;flex-direction:column;gap:6px}' +
      '.row{display:flex;gap:6px}input,textarea{width:100%;font-size:14px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);resize:none}' +
      '.send{border:0;border-radius:8px;background:' + color + ';color:#fff;padding:0 14px;font-weight:600;cursor:pointer}.send:disabled{opacity:.5;cursor:default}' +
      '.err{color:#dc2626;font-size:12px;min-height:0}' +
      '</style>' +
      '<div class="panel" role="dialog" aria-label="Chat"><div class="head"><span class="title"></span><button class="x" type="button" aria-label="Close chat">×</button></div>' +
      '<div class="list" aria-live="polite"></div>' +
      '<form class="form"><div class="row id"><input name="name" placeholder="Your name (optional)" autocomplete="name" maxlength="100"><input name="email" type="email" placeholder="Email (optional)" autocomplete="email" maxlength="200"></div>' +
      '<div class="row"><textarea name="body" rows="2" placeholder="Write a message…" aria-label="Message" maxlength="4000" required></textarea><button class="send" type="submit">Send</button></div><div class="err" role="alert"></div></form></div>' +
      '<button class="btn" type="button" aria-label="Open chat" aria-expanded="false"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>';
    document.body.appendChild(host);

    var $ = function (s) { return root.querySelector(s); };
    var panel = $('.panel'), list = $('.list'), form = $('.form'), btn = $('.btn'), err = $('.err'), send = $('.send');
    var nameIn = $('input[name=name]'), emailIn = $('input[name=email]'), bodyIn = $('textarea');
    $('.title').textContent = settings.name;
    if (token) $('.id').style.display = 'none';
    var timer = null;

    function render(messages) {
      list.textContent = '';
      if (settings.greeting) bubble('out', settings.greeting, '');
      messages.forEach(function (m) { bubble(m.direction, m.body, m.direction === 'out' ? m.agent : ''); });
      list.scrollTop = list.scrollHeight;
    }
    function bubble(dir, text, who) {
      if (who) { var w = document.createElement('div'); w.className = 'who'; w.textContent = who; list.appendChild(w); }
      var d = document.createElement('div');
      d.className = 'm ' + dir; // "in" = from the visitor (to the CRM), "out" = the team's reply
      d.textContent = text;
      list.appendChild(d);
    }
    function refresh() {
      if (!token) return render([]);
      request('GET', '/messages?token=' + encodeURIComponent(token)).then(function (r) { render(r.messages); }, function () {});
    }
    function toggle(open) {
      panel.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
      if (timer) { clearInterval(timer); timer = null; }
      if (open) { refresh(); timer = setInterval(refresh, 4000); bodyIn.focus(); }
    }
    btn.addEventListener('click', function () { toggle(!panel.classList.contains('open')); });
    $('.x').addEventListener('click', function () { toggle(false); btn.focus(); });
    bodyIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = bodyIn.value.trim();
      if (!text) return;
      send.disabled = true;
      err.textContent = '';
      var payload = { body: text };
      if (token) payload.token = token;
      if (nameIn.value.trim()) payload.name = nameIn.value.trim();
      if (emailIn.value.trim()) payload.email = emailIn.value.trim();
      request('POST', '/messages', payload).then(function (r) {
        token = r.token;
        try { localStorage.setItem(store, token); } catch { /* not persisted */ }
        $('.id').style.display = 'none';
        bodyIn.value = '';
        render(r.messages);
      }, function (x) {
        err.textContent = x.message === '429' ? 'Too many messages — please wait a minute.' : 'Your message could not be sent. Please try again.';
      }).then(function () { send.disabled = false; });
    });
  }
})();
