// Instagram publishing (official Graph API). IG_TOKEN = long-lived token of yahel.tik, IG_USER_ID = 17841472888123880.
const { E, post, get, log, load, save } = require('./lib');
const G = (E.IG_GRAPH || 'https://graph.instagram.com/v23.0').replace(/\/$/, '');
// Instagram-login tokens live 60 days: keep the newest one on the volume and refresh it weekly.
const tok = () => (load('ig_token', {}).token || E.IG_TOKEN || '');
async function refresh() {
  const cur = tok(); if (!cur || G.includes('graph.facebook.com')) return;
  try {
    const r = await get(`${G.replace(/\/v[\d.]+$/, '')}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(cur)}`);
    if (r.data && r.data.access_token) { save('ig_token', { token: r.data.access_token, at: new Date().toISOString() }); log({ ev: 'ig_token_refreshed' }); }
    else log({ ev: 'ig_refresh_fail', status: r.status, resp: JSON.stringify(r.data).slice(0, 200) });
  } catch (e) { log({ ev: 'ig_refresh_err', err: String(e) }); }
}
setInterval(refresh, 7 * 864e5); setTimeout(refresh, 60000);
const UID = E.IG_USER_ID || '17841472888123880';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function container(params) {
  const r = await post(`${G}/${UID}/media`, { ...params, access_token: tok() }, 60000);
  if (!r.data || !r.data.id) throw new Error('ig container ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 300));
  return r.data.id;
}
async function waitReady(id) {
  for (let i = 0; i < 60; i++) {
    const r = await get(`${G}/${id}?fields=status_code,status&access_token=${encodeURIComponent(tok())}`);
    const s = r.data && r.data.status_code;
    if (s === 'FINISHED') return;
    if (s === 'ERROR' || s === 'EXPIRED') throw new Error('ig processing ' + s + ' ' + (r.data.status || ''));
    await sleep(10000);
  }
  throw new Error('ig processing timeout');
}
async function publish(creationId) {
  const r = await post(`${G}/${UID}/media_publish`, { creation_id: creationId, access_token: tok() }, 60000);
  if (!r.data || !r.data.id) throw new Error('ig publish ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 300));
  return r.data.id;
}
async function permalink(mediaId) {
  try { const r = await get(`${G}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(tok())}`); return (r.data && r.data.permalink) || ''; } catch { return ''; }
}

async function reel(videoUrl, caption) {
  const id = await container({ media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: true });
  await waitReady(id); const mid = await publish(id); log({ ev: 'ig_reel', mid });
  return { id: mid, link: await permalink(mid) };
}
async function story(videoUrl) {
  const id = await container({ media_type: 'STORIES', video_url: videoUrl });
  await waitReady(id); const mid = await publish(id); log({ ev: 'ig_story', mid });
  return { id: mid };
}

module.exports = { reel, story, enabled: () => !!tok() };
