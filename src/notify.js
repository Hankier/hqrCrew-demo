// Pushes to your phone: ntfy (app on Android/iOS) and/or a Discord webhook. Both optional.
export async function notify(cfg, { title, text = '', url = '', tags = '', priority = '' }) {
  const n = cfg.notify || {};
  const jobs = [];
  if (n.ntfy?.url) {
    const headers = { Title: ascii(title), Tags: tags || 'robot' };
    if (url) headers.Click = url;
    if (priority) headers.Priority = priority;
    if (n.ntfy.token) headers.Authorization = `Bearer ${n.ntfy.token}`;
    jobs.push(fetch(n.ntfy.url, { method: 'POST', body: text || title, headers, signal: AbortSignal.timeout(10000) }));
  }
  if (n.discordWebhook) {
    const content = `**${title}**${text ? `\n${text}` : ''}${url ? `\n${url}` : ''}`.slice(0, 1900);
    jobs.push(fetch(n.discordWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'crew', content }), signal: AbortSignal.timeout(10000) }));
  }
  const results = await Promise.allSettled(jobs);
  return results.map((r) => (r.status === 'fulfilled' ? r.value.status : String(r.reason?.message || r.reason)));
}

// HTTP headers must be Latin-1; ntfy titles with Polish letters or emoji go in the body instead.
function ascii(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/[^\x20-\x7e]/g, '');
}
