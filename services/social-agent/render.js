// Video work with ffmpeg: vertical 1080x1920 reels/stories, Hebrew on-screen text (Heebo, RTL).
const { execFile } = require('child_process');
const fs = require('fs'), path = require('path');
const FONT = path.join(__dirname, 'fonts', 'Heebo-Black.ttf');
const W = 1080, H = 1920;
const MAX_TOTAL = 58;      // stories accept up to 60s
const MAX_CLIP = 20;       // one clip never runs longer than this
const IMG_SEC = 3;

const run = (bin, args) => new Promise((res, rej) => execFile(bin, args, { maxBuffer: 1 << 26 }, (e, out, err) => (e ? rej(new Error(String(err || e).slice(-800))) : res(String(out)))));

async function probe(file) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]));
  const types = (j.streams || []).map((s) => s.codec_type);
  const dur = parseFloat((j.format || {}).duration) || 0;
  const isVideo = types.includes('video') && dur > 0.5;
  return { isVideo, hasAudio: types.includes('audio'), duration: dur };
}

// items: [{file}] in order. Returns {file, duration, segments:[{start,end}]}.
async function assemble(items, out) {
  const metas = [];
  for (const it of items) metas.push({ ...it, ...(await probe(it.file)) });
  let total = 0; const use = [];
  for (const m of metas) {
    const len = m.isVideo ? Math.min(m.duration, MAX_CLIP) : IMG_SEC;
    if (total + len > MAX_TOTAL) { const left = MAX_TOTAL - total; if (left >= 2) use.push({ ...m, len: left }); break; }
    use.push({ ...m, len }); total += len;
  }
  if (!use.length) throw new Error('no usable media');
  const args = ['-v', 'error', '-y']; const f = []; const cat = []; let segs = []; let t = 0;
  use.forEach((m, i) => {
    if (m.isVideo) args.push('-t', String(m.len), '-i', m.file);
    else args.push('-loop', '1', '-t', String(m.len), '-i', m.file);
  });
  const silent = use.length; args.push('-f', 'lavfi', '-t', String(MAX_TOTAL + 2), '-i', 'anullsrc=r=44100:cl=stereo');
  use.forEach((m, i) => {
    f.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,format=yuv420p,trim=duration=${m.len},setpts=PTS-STARTPTS[v${i}]`);
    if (m.isVideo && m.hasAudio) f.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=duration=${m.len},asetpts=PTS-STARTPTS[a${i}]`);
    else f.push(`[${silent}:a]atrim=duration=${m.len},asetpts=PTS-STARTPTS[a${i}]`);
    cat.push(`[v${i}][a${i}]`);
    segs.push({ start: t, end: t + m.len, file: m.file, isVideo: m.isVideo }); t += m.len;
  });
  f.push(`${cat.join('')}concat=n=${use.length}:v=1:a=1[v][a]`);
  args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out);
  await run('ffmpeg', args);
  return { file: out, duration: t, segments: segs };
}

// overlays: [{lines:['...','...'], from, to}] seconds. Text is written to files (no escaping problems) and forced RTL.
async function overlay(input, overlays, out, workDir) {
  const parts = []; let n = 0;
  for (const o of overlays) {
    const lines = (o.lines || []).map((l) => String(l).trim()).filter(Boolean).slice(0, 3);
    lines.forEach((ln, i) => {
      const tf = path.join(workDir, `ov${n++}.txt`);
      fs.writeFileSync(tf, '‏' + ln.replace(/\n/g, ' ') + '‏');
      const size = ln.length > 22 ? 70 : 84;
      const y = 330 + i * 140;
      parts.push(`drawtext=fontfile='${FONT}':textfile='${tf}':fontsize=${size}:fontcolor=0x141414:box=1:boxcolor=white@0.93:boxborderw=26:x=(w-tw)/2:y=${y}:enable='between(t,${o.from.toFixed(2)},${o.to.toFixed(2)})'`);
    });
  }
  if (!parts.length) { fs.copyFileSync(input, out); return out; }
  await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vf', parts.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'copy', '-movflags', '+faststart', out]);
  return out;
}

// One JPG per source item for the AI to look at.
async function frames(segments, workDir) {
  const outs = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]; const o = path.join(workDir, `f${i}.jpg`);
    const args = ['-v', 'error', '-y'];
    if (s.isVideo) args.push('-ss', String(Math.min(1.5, (s.end - s.start) / 2)));
    args.push('-i', s.file, '-frames:v', '1', '-vf', 'scale=480:-2', o);
    try { await run('ffmpeg', args); outs.push(o); } catch { /* skip */ }
  }
  return outs;
}

// A text-only recruitment story (no new footage that day): 7s, brand-ish background, on-screen lines.
async function textStory(lines, out, workDir) {
  const base = path.join(workDir, 'bg.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x5b2a86:s=${W}x${H}:d=7:r=30`, '-f', 'lavfi', '-t', '7', '-i', 'anullsrc=r=44100:cl=stereo',
    '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', base]);
  return overlay(base, [{ lines, from: 0, to: 7 }], out, workDir);
}

// Spread AI overlays over the video; the last one always stays to the end.
function timeline(texts, duration) {
  const k = Math.max(1, texts.length); const step = duration / k;
  return texts.map((lines, i) => ({ lines, from: i * step, to: i === k - 1 ? duration + 1 : (i + 1) * step }));
}

module.exports = { probe, assemble, overlay, frames, textStory, timeline, FONT };
