export const AGENTS = [
  {id:'front_desk',name:'Front Desk',avatar:'💬',colour:'#C76B8A',link:'/inbox',actionTypes:['message_replied','message_escalated','booking_created','booking_confirmed','booking_rescheduled','booking_cancelled','booking_auto_cancelled','appointment_reminder'],jobs:['reminders','booking-confirmation-delivery'],sleepLabel:'Ready for the next enquiry'},
  {id:'content_creator',name:'Content Studio',avatar:'🎨',colour:'#D4943A',link:'/content',actionTypes:['content_drafted','content_posted','gap_post'],jobs:['content-scheduler'],sleepLabel:'Create a draft or schedule a post'},
  {id:'client_intel',name:'Client Intel',avatar:'🔮',colour:'#7B6BA8',link:'/rebook',actionTypes:['rebook_nudge','predictive_nudge','gap_fill','client_profile_updated','dormant_detected'],jobs:['client-intelligence-refresh','predictive-nudges','autonomous-cycle'],sleepLabel:'Visit patterns inform rebooking ideas'},
  {id:'bookkeeper',name:'Bookkeeper',avatar:'💷',colour:'#5BA97B',link:'/money',actionTypes:['income_logged','expense_logged','tax_drafted','receipt_processed','payment_recorded'],jobs:['auto-complete','recurring-expenses'],sleepLabel:'Review income and expenses'},
  {id:'business_coach',name:'Biz Coach',avatar:'📊',colour:'#4A90D9',link:'/insights',actionTypes:['value_coaching','quiet_week_detected'],jobs:['value-coaching','daily-heartbeat'],sleepLabel:'Insights use completed bookings'},
  {id:'guardian',name:'Guardian',avatar:'🛡️',colour:'#C9A96E',link:'/compliance',actionTypes:['review_request','review_requested','follow_up','aftercare_sent','patch_test_reminder','consultation_form_sent'],jobs:['aftercare-followups','follow-up-sequences'],sleepLabel:'Review the next client checks'},
];
const CADENCE={reminders:60,'booking-confirmation-delivery':5,'content-scheduler':5,'client-intelligence-refresh':60,'predictive-nudges':1440,'autonomous-cycle':120,'auto-complete':10,'recurring-expenses':1440,'value-coaching':60,'daily-heartbeat':1440,'aftercare-followups':60,'follow-up-sequences':60,'voice-profile-refresh-v2':60};
export const EVIDENCE_JOBS=Object.keys(CADENCE);

export function jobEvidence(name,row,now=Date.now()) {
  const success=Date.parse(row?.last_success_at||'');
  const stale=Number.isFinite(success) && now-success>(CADENCE[name]*2+60)*60000;
  return {name,state:!row?'unknown':row.consecutive_failures>0||stale?'attention':Number.isFinite(success)?'recent':'unknown',last_success_at:row?.last_success_at||null};
}
export function agentEvidence(actions,jobs,{now=Date.now(),todayStart=now-86400000,actionsAvailable=true,jobsAvailable=true}={}) {
  return AGENTS.map(agent=>{
    const rows=(actions||[]).filter(a=>agent.actionTypes.includes(a.action_type));
    const succeeded=rows.filter(a=>a.outcome==='success');
    const today=succeeded.filter(a=>Date.parse(a.created_at)>=todayStart);
    const last=rows[0];
    const checks=agent.jobs.map(name=>jobEvidence(name,jobsAvailable?(jobs||[]).find(j=>j.job_name===name):null,now));
    const pending=rows.filter(a=>['pending','escalated'].includes(a.outcome)).length;
    const failed=rows.filter(a=>a.outcome==='failed').length;
    return {id:agent.id,name:agent.name,avatar:agent.avatar,colour:agent.colour,link_to:agent.link,isActive:today.length>0,
      actionsToday:actionsAvailable?today.length:null,actionsThisWeek:actionsAvailable?succeeded.length:null,pending:actionsAvailable?pending:null,failed:actionsAvailable?failed:null,
      statusLine:!actionsAvailable?'Activity unavailable':last?last.outcome==='failed'?'Latest action needs attention':last.outcome==='pending'||last.outcome==='escalated'?'Latest action awaits review':last.summary||'Completed activity recorded':agent.sleepLabel,
      lastActionAt:last?.created_at||null,checks};
  });
}
