// ManyChat API (https://api.manychat.com). Key per Make connection id: MANYCHAT_KEY_<connId>, fallback MANYCHAT_API_KEY.
const key = (m) => process.env['MANYCHAT_KEY_' + ((m.parameters || {}).__IMTCONN__ || '')] || process.env.MANYCHAT_API_KEY;
async function mc(m, method, path, body, qs) {
  const u = new URL('https://api.manychat.com' + path); for (const [k, v] of Object.entries(qs || {})) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  const r = await fetch(u, { method, headers: { Authorization: 'Bearer ' + key(m), 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status >= 400 || j.status === 'error') throw new Error(`ManyChat ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j.data;
}
const W = { write: true, dryResult: () => ({}) };
module.exports = (reg) => {
  reg('manychat:GetSubscriberInfo', { run: (mp, p, { m }) => mc(m, 'GET', '/fb/subscriber/getInfo', null, { subscriber_id: mp.subscriberId }) });
  reg('manychat:FindSubscriberByCustomField', { multi: true, run: async (mp, p, { m }) => {
    const d = await mc(m, 'GET', '/fb/subscriber/findByCustomField', null, { field_id: mp.cFieldId, field_value: mp.cFieldValue });
    const a = Array.isArray(d) ? d : d ? [d] : []; const lim = Number(mp.limit) || a.length; return a.slice(0, lim);
  } });
  reg('manychat:FindSubscriberByName', { multi: true, run: async (mp, p, { m }) => { const d = await mc(m, 'GET', '/fb/subscriber/findByName', null, { name: mp.name }); return Array.isArray(d) ? d : []; } });
  reg('manychat:FindSubscriberBySystemField', { multi: true, run: async (mp, p, { m }) => { const d = await mc(m, 'GET', '/fb/subscriber/findBySystemField', null, { email: mp.email, phone: mp.phone }); return d ? [d] : []; } });
  reg('manychat:CreateSubscriber', { ...W, dryResult: () => ({ id: 'dry-run' }), run: (mp, p, { m }) => mc(m, 'POST', '/fb/subscriber/createSubscriber', {
    first_name: mp.firstName || undefined, last_name: mp.lastName || undefined, phone: mp.phone || undefined, whatsapp_phone: mp.whatsAppPhone || undefined, email: mp.email || undefined, gender: mp.gender || undefined,
    has_opt_in_sms: mp.hasOptInSms === true || mp.hasOptInSms === 'true', has_opt_in_email: mp.hasOptInEmail === true || mp.hasOptInEmail === 'true', consent_phrase: mp.consentPhrase || undefined }) });
  reg('manychat:SetSubscriberCustomField', { ...W, run: (mp, p, { m }) => mc(m, 'POST', '/fb/subscriber/setCustomField', { subscriber_id: Number(mp.subscriberId) || mp.subscriberId, field_id: Number(mp.cFieldId) || mp.cFieldId, field_value: mp.cFieldValue }) });
  reg('manychat:SendFlow', { ...W, run: (mp, p, { m }) => mc(m, 'POST', '/fb/sending/sendFlow', { subscriber_id: Number(mp.subscriberId) || mp.subscriberId, flow_ns: mp.flowName || mp.flowNs || mp.flow_ns }) });
  reg('manychat:SendText', { ...W, run: (mp, p, { m }) => mc(m, 'POST', '/fb/sending/sendContent', { subscriber_id: Number(mp.subscriberId) || mp.subscriberId, data: { version: 'v2', content: { type: 'whatsapp', messages: [{ type: 'text', text: mp.text }] } } }) });
  reg('manychat:AddTag', { ...W, run: (mp, p, { m }) => mc(m, 'POST', '/fb/subscriber/addTagByName', { subscriber_id: Number(mp.subscriberId), tag_name: mp.tagName || mp.tag }) });
  reg('manychat:RemoveTag', { ...W, run: (mp, p, { m }) => mc(m, 'POST', '/fb/subscriber/removeTagByName', { subscriber_id: Number(mp.subscriberId), tag_name: mp.tagName || mp.tag }) });
  reg('manychat:PerformAction', { ...W, run: async (mp, p, { m }) => {
    const sub = Number(mp.subscriberId) || mp.subscriberId;
    for (const a of mp.actions || []) {
      switch (a.action) {
        case 'set_field_value': await mc(m, 'POST', '/fb/subscriber/setCustomFieldByName', { subscriber_id: sub, field_name: a.field_name, field_value: a.value }); break;
        case 'unset_field_value': await mc(m, 'POST', '/fb/subscriber/setCustomFieldByName', { subscriber_id: sub, field_name: a.field_name, field_value: null }); break;
        case 'add_tag': await mc(m, 'POST', '/fb/subscriber/addTagByName', { subscriber_id: sub, tag_name: a.tag_name || a.value }); break;
        case 'remove_tag': await mc(m, 'POST', '/fb/subscriber/removeTagByName', { subscriber_id: sub, tag_name: a.tag_name || a.value }); break;
        case 'send_flow': await mc(m, 'POST', '/fb/sending/sendFlow', { subscriber_id: sub, flow_ns: a.flow_ns || a.value }); break;
        default: throw new Error('ManyChat action not supported: ' + a.action);
      }
    }
    return {};
  } });
};
