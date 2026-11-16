module.exports=function classify(input){
const g=s=>String(s==null?'':s);
const chatId=g(input.chatId), type=g(input.type);
const text=(g(input.t1)||g(input.t2)).trim();
const chatName=g(input.chatName);
const sender=g(input.sender).replace(/\D/g,'');
const CUST={'528485906':'הצעת התחברות מבזק (סיבים עד 1000 מגה, 119 ש״ח לשנה)'};
const s9=sender.slice(-9);
// RULE (Steve 08/11/2026): from the group, save only messages of managers (סטיב, ירדן, הילה, קורל, שחר אביטוב) or of the bot's own number, and only real work updates (AI filter in module 60). Do not remove when editing this scenario.
// RULE (Steve 08/11/2026): private messages starting with תזכיר לי / תזכורת go to the reminders intake (scenario 10125213) via route 32. Do not remove.
// RULE (Steve 09/11/2026): private messages "ניתוק N - ..." and "ביטול N - ..." are rep answers on disconnects / cancellations -> scenario 10112529 via route 31. Do not remove.
// RULE (Steve 09/11/2026): private messages starting with שיקוף + a phone number = rep reports the other phone the שיקוף was done on (husband, son...) -> route 33 writes it to column O of the שיקופים bot report. Do not remove.
// RULE (Steve 10/11/2026): private messages starting with ניוד = Pelephone porting request -> scenario 9937792 (ניודים 1) via route 70. Do not remove.
// RULE (Steve 10/11/2026): rep reports (not questions) that a customer cancelled (ביטל...) or was saved (שמרתי / שומר...) -> WhatsApp to Coral via route 71; "שיקפתי" -> reply that the שיקופים bot checks by itself. Do not remove.
// RULE (Steve 10/11/2026): numbered answers without the word ביטול/ניתוק ("1 ...\n2 ...", or "1 - ...") go to route 31 (scenario 10112529 decides if they are cancellations or disconnects). Do not remove.
// RULE (Steve 10/11/2026): a numbered message whose first word after the number is a question word (מה/איך/למה/כמה/מתי/האם/מי/איפה/למי/אפשר/מותר) is a question, not an answer - it stays private even without '?'. Do not remove.
// RULE (Steve 10/11/2026): any report with שוקף/שוקפה/שיקפתי + a phone number (e.g. "רחל בניטה שוקפה ממספר 050...") goes to route 33 (written to column O of the שיקופים bot report and checked). "שוקף" without a phone = shikdone. "בוטל 1 ... / 2 ..." = numbered disconnect answers -> route 31. Do not remove.
// RULE (Steve 10/11/2026): a private message that is only the word שיקוף (or שיקופים) -> route 33 fixed script (list of the rep's deals without שיקוף + format "שיקוף <מספר מהרשימה> <טלפון>"), no AI. Do not remove.
const MGRS=['544604246','504445169','525192071','584896222','542607144'];
const isOut=/^outgoing/.test(type);
const mgr=isOut||MGRS.includes(s9)||/שחר/.test(g(input.senderName));
let kind='ignore';
let cmsg='';
let bzCode='',bzText='',bzStatus=''; // RULE (Steve 15/11/2026): Reply להודעת 'עדכון מבזק' (הקישור בה מכיל r=<טלפון לקוח>) או 'בזק <טלפון לקוח> טקסט' = תגובת נציג לבזק -> route 91 (Apps Script doPost). Do not remove.
if(type==='incomingMessageReceived' && chatId.endsWith('@c.us') && CUST[s9]){
  kind='customer';
  const body=text||('['+(g(input.tm)||'הודעה')+']');
  cmsg='📩 לקוחה ענתה לבוט יהל תקשורת\nמספר: 0'+s9+(g(input.senderName)?' ('+g(input.senderName)+')':'')+'\nעל ההודעה: '+CUST[s9]+'\n\nהתשובה שלה:\n'+body;
}
else if((type==='incomingMessageReceived'||(/^outgoing(API)?MessageReceived$/.test(type)&&chatId.endsWith('@g.us'))) && text){
  if(chatId.endsWith('@g.us')){ if(/סיירת|יהל/.test(chatName)) kind='group'; }
  else if(chatId.endsWith('@c.us')){
    const hasId=/(\d{6,9}|0?5\d[-\s]?\d{3}[-\s]?\d{4})/.test(text);
    const startsAdv=/^\s*(הקדמה|להקדים|תקדים)/.test(text)&&hasId; // RULE (Steve 11/11/2026): one-line advance goes straight only with a customer number/phone; otherwise the bot's wizard opens. Do not remove.
    const intentAdv=hasId&&/(התקנה|הקדמ|להקדים|תקדים)/.test(text)&&/(ראשון|שני|שלישי|רביעי|חמישי|שישי|מחר|מחרתיים|היום|\d{1,2}[./]\d{1,2})/.test(text)&&!/(סטטוס|מה קורה|מה המצב|אושר|נדחה|ענו|תשובה)/.test(text);
    const numL=/^\s*[1-9]\d?\s*[-–.):]?\s+[א-ת]/;
    const numQ=/^\s*[1-9]\d?\s*[-–.):]?\s*(מה|איך|למה|כמה|מתי|האם|מי|איפה|למי|אפשר|מותר)(?![א-ת])/;
    const isNumAns=!/\?/.test(text)&&!numQ.test(text)&&numL.test(text)&&(/\n\s*[1-9]\d?\s*[-–.):]?\s+[א-ת]/.test(text)||/^\s*[1-9]\d?\s*[-–.):]\s*[א-ת]/.test(text));
    const isHdrAns=!/\?/.test(text)&&/^\s*(בוטל[וה]?|ביטל[וה]?|ביטולים|ניתוקים)\s*:?\s*[1-9]\d?\s*[-–.):]?\s*[א-ת]/.test(text);
    const isDisc=/^\s*ניתוק\s*\d/.test(text)||/^\s*ביטול\s*\d{1,2}(\s*[-–.):]|\s)/.test(text)||isNumAns||isHdrAns;
    const isRem=/^\s*(תזכיר|תזכירי|תזכורת|להזכיר לי|הזכר לי|תזכר לי)/.test(text);
    const SHW=/(^|[^א-ת])(שיקוף|שקוף|שוקף|שוקפה|שוקפו|שיקפתי|שקפתי|שיקפנו|שיקפה|שיקף)(?![א-ת])/;
    const isShik=(/^\s*(שיקוף|שקוף)/.test(text)||(SHW.test(text)&&!/\?/.test(text)&&!/^\s*(מה|האם|איך|למה|מתי|אפשר|מותר|כמה|מי|איפה|למי)(?![א-ת])/.test(text)))&&/(?:972|0)?5\d(?:[-\s]?\d){7}/.test(text)||/^\s*(שיקוף|שקוף|שיקופים)\s*[.!]*\s*$/.test(text);
    const isPort=/^\s*ניוד/.test(text);
    const isBezeq=/^\s*(בזק|תיאום בזק|טופס בזק|תאום בזק)\s*[.!]*\s*$/.test(text); // RULE (Steve 15/11/2026): the word בזק alone -> personal link to the Bezeq coordination form (route 90). Do not remove.
    const isQ=/\?/.test(text)||/^\s*(מה|האם|איך|למה|מתי|אפשר|מותר|כמה|מי|איפה|למי|תגיד|תבדוק|יש)(?![֐-׿])/.test(text);
    const W=re=>new RegExp('(^|[^\\u0590-\\u05FF])('+re+')(?![\\u0590-\\u05FF])').test(text);
    const isShikDone=!isQ&&(W('שיקפתי|שקפתי|שיקפנו|שיקפה|שיקף|שוקף|שוקפה|שוקפו')||/עשיתי (לו |לה )?שיקוף|שיקוף בוצע|בוצע שיקוף/.test(text));
    const isCancel=!isQ&&W('ביטל|ביטלה|בוטל|בוטלה|מבטל|מבטלת|לבטל|ביטלו');
    const isSave=!isQ&&W('שמרתי|שימרתי|נשמר|נשמרה|שומר|שומרת|שומרה|שימרה|שימור');
    const qq=g(input.q); const qm=/עדכון מבזק/.test(qq)?qq.match(/[?&]r=(\d{8,10})/):null; const rm=text.match(/^\s*בזק\s+0?(5\d{8})\s+([\s\S]+)/);
    if(qm&&text){bzCode=qm[1];bzText=text;} else if(rm){bzCode=rm[1];bzText=rm[2];}
    // RULE (Steve 15/11/2026): Bezeq reply may start with a status number: 1 ממתין לתיאום, 2 המשך טיפול, 3 אין מענה, 4 בוטל, then free description (goes to notes). Without a number, clear keywords set the status; otherwise only the note is saved. Do not remove.
    if(bzCode){
      const BZS={'1':'ממתין לתיאום','2':'המשך טיפול','3':'אין מענה','4':'בוטל'};
      const nm=bzText.match(/^\s*([1-4])(?!\d)\s*[-–.):]?\s*([\s\S]*)$/);
      if(nm){bzStatus=BZS[nm[1]];bzText=nm[2].trim()||('סטטוס: '+bzStatus);}
      else{
        const KW=re=>new RegExp('(^|[^֐-׿])('+re+')(?![֐-׿])').test(bzText);
        if(KW('ביטל|ביטלה|בוטל|בוטלה|מבטל|מבטלת|לא מעוניין|לא מעוניינת')) bzStatus='בוטל';
        else if(/לא עונה|לא ענה|לא ענתה|אין מענה/.test(bzText)) bzStatus='אין מענה';
        else if(!/לא\s+(זמי|מוכ|יכול|אפשר)/.test(bzText)&&KW('זמין|זמינה|מוכן|מוכנה|ממתין לתיאום|אפשר לתאם|יכולה לתאם|יכול לתאם')) bzStatus='ממתין לתיאום';
      }
    }
    kind=bzCode?'bezeqreply':isBezeq?'bezeq':isShik?'shikuf':(isDisc?'disc':(isRem?'reminder':(isPort?'port':(isShikDone?'shikdone':(isCancel?'cancel':(isSave?'save':((startsAdv||intentAdv)?'advance':'private')))))));
  }
}
// RULE (15/11/2026, Claude reroute): the question service can hand a report back with forceKind (only these kinds, never private). Do not remove.
if(["cancel", "save", "shikdone", "shikuf", "disc", "port", "reminder", "advance"].includes(String(input.forceKind||''))&&text) kind=String(input.forceKind);
const fwd=JSON.stringify({chatId:chatId,sender:sender,senderName:g(input.senderName),text:text});
const dfwd=JSON.stringify({phone:sender,text:text});
const pfwd=JSON.stringify({last_input_text:text,whatsapp_phone:sender,name:g(input.senderName),id:'',src:'green'});
const MONTHS=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const nowIL=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Jerusalem'}));
const mt=off=>{const d=new Date(nowIL.getFullYear(),nowIL.getMonth()+off,1); return "'"+MONTHS[d.getMonth()]+' '+d.getFullYear()+"'!A1:O2000";};
const mbody=JSON.stringify({dataFilters:[{a1Range:mt(0)},{a1Range:mt(-1)}],valueRenderOption:'FORMATTED_VALUE'});
return {kind,text,chatId,sender,bzbody:JSON.stringify({secret:'yahel-bezeq-reply-2026',phone:sender,text:bzText,code:bzCode,status:bzStatus}),bzStatus,bzCode,tokenSrc:sender+'yahel-bezeq-2026',senderName:g(input.senderName),chatName,id:g(input.id),ts:g(input.ts),len:text.length,fwd,dfwd,pfwd,mbody,cmsg,mgr:mgr?'yes':'no'};

};
