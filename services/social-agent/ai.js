// Claude: captions, on-screen text, daily trend idea.
const fs = require('fs');
const { E, post, log } = require('./lib');
const MODEL = E.CLAUDE_MODEL || 'claude-sonnet-5-5';

// Learned from yahel.tik (Nov 2026): only short reels shot on a phone, self-irony and a young-team vibe,
// one-line captions with an emoji, 🥁 is the signature, fixed hashtags. Best performers were short teasers.
const STYLE = `אתה מנהל הסושיאל של יהל תקשורת – מוקד מכירות טלפוני בנהריה (yes, בזק, פלאפון). מטרת העמוד yahel.tik: להביא עובדים.
סגנון העמוד: רילסים קצרים מהטלפון, הומור עצמי, אווירה של צוות צעיר וכיפי. כיתוב של שורה-שתיים, אימוג'י, 🥁 הוא סימן ההיכר.
טקסט על המסך ברילסים: משפט הוק אחד בסגנון מם/סקיט שמחזיק את כל הסרטון, למשל "Pov: אתה העובד שאחראי על המורל במוקד", "כשהמנהל עובר בהפתעה", "כשהבוס שלך במוד מנהל ולא במוד חבר:", "עונת המעבר במוקד: ...".
טקסט על המסך בסטורים: 2–4 שורות קצרות ושמחות עם אימוג'י בסוף שורה (💪🏼🚀💸✨🍔), למשל "ככה סוגרים שבוע 💪🏼🚀" / "רק במשרד שלנו תראו ארוחות צהריים כאלו 😋" / "ואתם עדיין לא עובדים אצלנו?" / "למה אתם מחכים? שלחו לנו הודעה".
האשטגים קבועים: #יהלתקשורת #מוקדמכירות #דרושים #דרושיםבנהריה.
עברית טבעית ויומיומית. אסור שיישמע כמו AI: בלי "לא רק X אלא Y", בלי רשימות של שלוש, בלי מילים מליציות.
חוקים קשיחים: אסור להזכיר yes כשם העסק או לוגו yes; אסור מספרי מכירות, הכנסות או כסף של העסק; המשמרת היחידה 09:30–17:30;
בפרסומי גיוס המספר היחיד הוא של שחר 054-2607144; כתובת: היוצרים 2, נהריה.`;

async function claude(messages, { max = 1500, tools, system = STYLE } = {}) {
  if (!E.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
  const body = { model: MODEL, max_tokens: max, system, messages };
  if (tools) body.tools = tools;
  const r = await post((E.ANTHROPIC_URL || 'https://api.anthropic.com') + '/v1/messages', body, 180000, { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
  if (r.status >= 300) throw new Error('claude ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 300));
  return (r.data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}
const json = (t) => { const m = String(t).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; };
const img = (f) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });

// note = what the sender wrote; framesList = one jpg per item; feedback/previous for a correction round.
async function draft({ note, framesList, feedback, previous }) {
  const content = framesList.map(img);
  content.push({ type: 'text', text: `אלה ${framesList.length} פריטים (לפי הסדר, מספור מ-0) שהצוות שלח לסושיאל.
מה שכתבו עליהם: "${note || '(לא כתבו כלום)'}"
${previous ? `הטיוטה הקודמת: ${JSON.stringify(previous)}\nהתיקון שירדן ביקש: "${feedback}"\nתקן לפי הבקשה ושמור על כל השאר.` : ''}
החזר JSON בלבד:
{"caption":"כיתוב לפוסט – שורה-שתיים קצרות, אימוג'י, קריאה קצרה להצטרף, והאשטגים",
 "reel_text":["הוק לרילס – 1–2 שורות, עד 30 תווים בשורה, אפשר אימוג'י אחד בסוף"],
 "story_text":["2–4 שורות לסטורי, עד 28 תווים בשורה, אימוג'י בסוף שורות, השורה האחרונה קריאה לשלוח הודעה"],
 "song":"שם שיר טרנדי שמתאים (אמן – שיר), או ריק",
 "exclude":[מספרי פריטים שרואים בהם מסך מחשב/טלפון, מסמך או דוח עם פרטי לקוחות],
 "warning":"משפט קצר אם משהו לא מתאים לפרסום, אחרת ריק"}
הטקסט על המסך חובה תמיד, גם ברילס וגם בסטורי.` });
  const out = json(await claude([{ role: 'user', content }]));
  const arr = (a) => (Array.isArray(a) ? a : a ? [a] : []).map((l) => String(l).trim()).filter(Boolean).slice(0, 4);
  if (!out || !out.caption) throw new Error('bad draft from AI');
  out.reel_text = arr(out.reel_text); out.story_text = arr(out.story_text);
  if (!out.reel_text.length && Array.isArray(out.overlays)) out.reel_text = arr([].concat(...out.overlays.map((o) => (Array.isArray(o) ? o : [o]))).slice(0, 2));
  if (!out.reel_text.length) throw new Error('AI returned no on-screen text');
  if (!out.story_text.length) out.story_text = out.reel_text.concat(['שלחו לנו הודעה 💪🏼']);
  out.exclude = Array.isArray(out.exclude) ? out.exclude.map(Number).filter((n) => Number.isInteger(n)) : [];
  return out;
}

// Morning idea based on what's trending this week (web search).
async function dailyIdea(recentCaptions) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
  return claude([{ role: 'user', content: `חפש מה טרנדי השבוע ברילסים ובטיקטוק בישראל (פורמטים, בדיחות, סאונדים) שמתאים למשרד מכירות עם צוות צעיר.
מה עלה אצלנו לאחרונה: ${recentCaptions || 'לא ידוע'}.
כתוב לירדן הודעת וואטסאפ קצרה (עד 8 שורות): רעיון אחד לצילום היום – מה מצלמים, מי, כמה שניות, מה ייכתב על המסך, ואיזה סאונד/שיר.
בלי הקדמות, בלי מקורות, בעברית יומיומית. תתחיל ב"💡 רעיון לרילס היום:"` }], { max: 1200, tools });
}

// Text-only recruitment story when there is no new footage.
async function storyText() {
  const out = json(await claude([{ role: 'user', content: `כתוב סטורי גיוס טקסטואלי לאינסטגרם ליום שאין בו סרטון חדש.
החזר JSON בלבד: {"lines":["שורה 1","שורה 2","שורה 3"],"caption":""}
3 שורות על המסך, עד 26 תווים בשורה, עם אימוג'י בסוף שורות (בסגנון הסטורים שלנו). אפשר להזכיר: 100 ₪ לשעה, ממוצע 13,000+, 09:30–17:30, נהריה, צוות צעיר, הכשרה מלאה.
שורה אחרונה: "שחר 054-2607144".` }], { max: 400 }));
  if (!out || !Array.isArray(out.lines)) throw new Error('bad story from AI');
  return out;
}

module.exports = { draft, dailyIdea, storyText, claude };
