const DAY=86400000;
export function businessInsights(appointments,treatments,{now=Date.now()}={}) {
  const start=now-56*DAY;
  const rows=(appointments||[]).filter(a=>a.status==='completed' && Date.parse(a.starts_at)>=start && Date.parse(a.ends_at||a.starts_at)<=now);
  const services=new Map((treatments||[]).filter(t=>t.is_active!==false && t.price_cents>0).map(t=>[t.id,t]));
  const cards=[];
  const recent=rows.filter(a=>Date.parse(a.starts_at)>=now-28*DAY);
  const prior=rows.filter(a=>Date.parse(a.starts_at)<now-28*DAY);
  if(recent.length>=4 && prior.length>=4) {
    const change=recent.length-prior.length;
    cards.push({id:'visit-trend',type:'visit_trend',title:change>=0?'Your recent diary':'A quieter four weeks',summary:`${recent.length} completed bookings in the last 28 days, compared with ${prior.length} in the previous 28. ${Math.abs(change)} ${change>=0?'more':'fewer'} bookings.`,evidence:`${rows.length} completed bookings across 56 days`,action_label:'Review the diary',link_to:'/calendar/week',confidence:'observed',priority:change<0?85:45});
  }
  const days=new Map();
  for(const a of rows) {const key=new Date(a.starts_at).getUTCDay();days.set(key,(days.get(key)||0)+1);}
  const top=[...days].sort((a,b)=>b[1]-a[1])[0];
  if(top && top[1]>=4) {
    const name=['Sundays','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays'][top[0]];
    cards.push({id:'popular-day',type:'popular_day',title:`${name} bring the most visits`,summary:`${top[1]} of your ${rows.length} completed bookings in the last eight weeks fell on ${name}. Check spare time on those days before opening extra hours.`,evidence:'Observed bookings; this is not an occupancy percentage',action_label:'Look for gaps',link_to:'/smart-schedule',confidence:'observed',priority:50});
  }
  const grouped=new Map();
  for(const a of rows) {if(!a.client_id)continue;const key=`${a.client_id}:${a.starts_at.slice(0,10)}`;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(a);}
  const pairs=new Map();
  for(const group of grouped.values()) {
    group.sort((a,b)=>a.starts_at.localeCompare(b.starts_at));const counted=new Set();
    for(let i=1;i<group.length;i++) {
      const before=group[i-1],after=group[i];const gap=Date.parse(after.starts_at)-Date.parse(before.ends_at);
      if(!Number.isFinite(gap)||gap<0||gap>30*60000||before.treatment_id===after.treatment_id)continue;
      const a=services.get(before.treatment_id),b=services.get(after.treatment_id);if(!a||!b)continue;
      const key=[a.id,b.id].sort().join(':');if(counted.has(key))continue;counted.add(key);
      const pair=pairs.get(key)||{names:[a.name,b.name],count:0};pair.count++;pairs.set(key,pair);
    }
  }
  const pair=[...pairs.values()].sort((a,b)=>b.count-a.count)[0];
  if(pair?.count>=3)cards.push({id:'treatment-pair',type:'treatment_pair',title:'Two treatments clients book together',summary:`${pair.names.join(' and ')} appeared together in ${pair.count} client visits. Consider mentioning the combination when it suits the client.`,evidence:'Same client, same day, appointments no more than 30 minutes apart',action_label:'Review treatments',link_to:'/treatments',confidence:'observed',priority:65});
  const counts=new Map();for(const a of recent)if(services.has(a.treatment_id))counts.set(a.treatment_id,(counts.get(a.treatment_id)||0)+1);
  const popular=[...counts].sort((a,b)=>b[1]-a[1])[0];
  if(popular?.[1]>=4) {
    const service=services.get(popular[0]);const estimate=popular[1]*300;
    cards.push({id:'price-scenario',type:'price_scenario',title:'A pricing scenario to consider',summary:`At the same ${popular[1]} bookings per 28 days, a £3 increase for ${service.name} would add £${(estimate/100).toFixed(0)} in gross booking value. Demand and costs may change.`,evidence:'A scenario using recent bookings, not a revenue forecast',action_label:'Review prices',link_to:'/price-list',confidence:'scenario',impact_pence:estimate,priority:35});
  }
  return cards.sort((a,b)=>b.priority-a.priority).slice(0,3);
}
