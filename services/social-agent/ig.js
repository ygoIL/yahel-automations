// Instagram publishing (official Graph API). IG_TOKEN = long-lived token of yahel.tik, IG_USER_ID = 17841472888123880.
const { E, post, get, log } = require('./lib');
const G = (E.IG_GRAPH || 'https://graph.instagram.com/v23.0').replace(/\/$/, '');
const UID = E.IG_USER_ID || '17841472888123880';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function container(params) {
  const r = await post(`${G}/${UID}/media`, { ...params, access_token: E.IG_TOKEN }, 60000);
  if (!r.data || !r.data.id) throw new Error('ig container ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 300));
  return r.data.id;
}
async function waitReady(id) {
  for (let i = 0; i < 60; i++) {
    const r = await get(`${G}/${id}?fields=status_code,status&access_token=${encodeURIComponent(E.IG_TOKEN)}`);
    const s = r.data && r.data.status_code;
    if (s === 'FINISHED') return;
    if (s === 'ERROR' || s === 'EXPIRED') throw new Error('ig processing ' + s + ' ' + (r.data.status || ''));
    await sleep(10000);
  }
  throw new Error('ig processing timeout');
}
async function publish(creationId) {
  const r = await post(`${G}/${UID}/media_publish`, { creation_id: creationId, access_token: E.IG_TOKEN }, 60000);
  if (!r.data || !r.data.id) throw new Error('ig publish ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 300));
  return r.data.id;
}
async function permalink(mediaId) {
  try { const r = await get(`${G}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(E.IG_TOKEN)}`); return (r.data && r.data.permalink) || ''; } catch { return ''; }
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

module.exports = { reel, story, enabled: () => !!E.IG_TOKEN };
