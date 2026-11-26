# social-agent – מנהל הסושיאל של yahel.tik

Railway service (project `yahel-reps-bot`, service `social-agent`, Dockerfile – needs ffmpeg).

## Flow
1. ירדן / סטיב שולחים לבוט (אותו קו גרין של wa-gateway) תמונות/סרטונים עם המילה **סושיאל** (בכיתוב של הראשון). עוד חומרים תוך 20 דק' מצטרפים.
2. 3 דקות בלי חומרים (או "סושיאל סיום") → סרטון אנכי 1080x1920, **כיתוב על המסך תמיד** (Heebo, RTL), כיתוב לפוסט ושיר מומלץ מ-Claude. פריטים עם מסכים/פרטי לקוחות יוצאים.
3. תצוגה מקדימה לירדן בוואטסאפ ("🎬 סושיאל #id"). תשובה על ההודעה: **כן** → רילס + סטורי ב-yahel.tik; **לא** → ביטול; כל טקסט אחר → תיקון וטיוטה חדשה.
4. פרסום פעם אחת בלבד (status guard). תזכורת אחרי 24 שעות, נסגר אחרי 72.
5. א'–ה': 09:20 רעיון לרילס לפי טרנדים (Claude + web search) לירדן; 16:30 אם לא עלה כלום היום – סטורי גיוס טקסטואלי לאישור.
6. פקודות: "סושיאל רעיון", "סושיאל סטורי", "סושיאל סיום".

wa-gateway שולח כל הודעה פרטית של SOCIAL_SENDERS ל-`/claim` קודם; מה שלא נלקח ממשיך לבוט הנציגים כרגיל.

## Env
`SOCIAL_KEY, PUBLIC_URL (https://social-agent-…up.railway.app), GREEN_BASE, GREEN_TOKEN (same instance as wa-gateway GREEN_P_*),
ANTHROPIC_API_KEY, CLAUDE_MODEL?, IG_TOKEN (long-lived, yahel.tik), IG_USER_ID=17841472888123880, IG_GRAPH? (default graph.instagram.com/v23.0),
APPROVER?=504445169, SOCIAL_SENDERS?=504445169,544604246, DATA_DIR=/data` (volume).
wa-gateway needs: `SOCIAL_URL, SOCIAL_KEY` (same key).

## Test
`node test/e2e.js clip.mov photo.jpg …` – fake Green/Claude/Instagram, checks routing, render, correction, single publish.
