module.exports = (reg) => {
  reg('elevenlabs:createSpeechToText', { write: true, dryResult: () => ({ text: '', words: [] }), run: async (mp) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(mp)) { if (v === undefined || v === null || v === '' || k === 'file') continue; fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v)); }
    if (mp.file && mp.file.data) fd.append('file', new Blob([mp.file.data]), mp.file.fileName || 'audio');
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '' }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 400) throw new Error(`ElevenLabs ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
    return j;
  } });
};
