import 'dotenv/config';
import fs from 'node:fs';
import { Client, EmbedBuilder, PermissionsBitField } from 'discord.js';

const DATA_FILE = './settings.json';
const cache = new Map();
const inflight = new Map();
const GOOGLE_KEY = process.env.GOOGLE_SAFE_BROWSING_API_KEY || '';
const CACHE_MS = 10 * 60 * 1000;
const MAX_URLS_PER_MESSAGE = 8;
const GOOGLE_BATCH = 50;

// Known IP-logger / tracking services. This is intentionally a small, high-confidence list
// so ordinary links are not falsely removed. Safe Browsing is used when an API key is present.
const IP_LOGGER_HOSTS = new Set([
  'grabify.link', 'grabify.icu', 'grabify.rocks', 'grabify.org', 'grabify.click',
  'iplogger.com', 'iplogger.org', 'iplogger.co', 'iplogger.ru', 'iplogger.info',
  '2no.co', '2no.co', 'yip.su', 'ps3cfw.com', 'blasze.com', 'bmwforum.co',
  'iplis.ru', 'iplog.co', 'ip-tracker.org', 'iplogger.org'
]);

const SHORTENER_HOSTS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'is.gd', 'cutt.ly', 'rb.gy', 'shorturl.at', 'rebrand.ly'
]);

function load(){try{return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch{return {};}}
const data=load();
function cfg(gid){if(!data[gid])data[gid]={};return data[gid];}
function isMod(member){return !!(member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)||member?.permissions?.has(PermissionsBitField.Flags.ManageMessages)||member?.permissions?.has(PermissionsBitField.Flags.Administrator));}
function urlsFromText(text=''){
  const found=[];
  const re=/(?:https?:\/\/|www\.)[^\s<>]+/gi;
  for(const raw of text.match(re)||[]){
    const cleaned=raw.replace(/[)>\]}>,.!?]+$/,'');
    try{
      const normalized=cleaned.toLowerCase().startsWith('www.')?`https://${cleaned}`:cleaned;
      const u=new URL(normalized);
      if(!['http:','https:'].includes(u.protocol))continue;
      found.push({raw:cleaned,url:u});
    }catch{}
  }
  return [...new Map(found.map(x=>[x.url.href,x])).values()].slice(0,MAX_URLS_PER_MESSAGE);
}
function hostMatches(host,set){
  const h=host.toLowerCase().replace(/^www\./,'');
  for(const domain of set)if(h===domain||h.endsWith(`.${domain}`))return true;
  return false;
}
function localVerdict(item){
  const u=item.url, host=u.hostname.toLowerCase();
  if(hostMatches(host,IP_LOGGER_HOSTS))return 'IP logger / tracking service';
  if(u.username||u.password)return 'URL contains embedded credentials';
  // Block obvious executable/download payloads only when the URL itself is clearly a file payload.
  if(/\.(?:exe|scr|msi|bat|cmd|ps1|vbs|vbe|jar|hta|apk|dmg|iso)(?:$|[?#])/i.test(u.pathname))return 'direct executable download';
  return null;
}
function cached(url){const x=cache.get(url);if(!x||Date.now()-x.time>CACHE_MS){cache.delete(url);return null;}return x.value;}
function put(url,value){cache.set(url,{value,time:Date.now()});if(cache.size>2000)cache.delete(cache.keys().next().value);}
async function safeBrowsing(urls){
  if(!GOOGLE_KEY||!urls.length)return new Map();
  const result=new Map();
  for(let i=0;i<urls.length;i+=GOOGLE_BATCH){
    const batch=urls.slice(i,i+GOOGLE_BATCH);
    try{
      const res=await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(GOOGLE_KEY)}`,{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({
          client:{clientId:'discord-content-moderator',clientVersion:'1.0.0'},
          threatInfo:{
            threatTypes:['MALWARE','SOCIAL_ENGINEERING','UNWANTED_SOFTWARE','POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes:['ANY_PLATFORM'],threatEntryTypes:['URL'],
            threatEntries:batch.map(url=>({url}))
          }
        })
      });
      if(!res.ok){console.error('[link] Safe Browsing lookup failed:',res.status);continue;}
      const body=await res.json();
      for(const match of body.matches||[])if(match.threat?.url)result.set(match.threat.url,match.threatType||'unsafe URL');
    }catch(e){console.error('[link] Safe Browsing request failed:',e?.message||e);}
  }
  return result;
}
async function reputation(urls){
  const verdicts=new Map(), missing=[];
  for(const url of urls){const hit=cached(url);if(hit)verdicts.set(url,hit);else missing.push(url);}
  if(missing.length){const safe=await safeBrowsing(missing);for(const url of missing){const v=safe.get(url)||null;put(url,v);verdicts.set(url,v);}}
  return verdicts;
}
async function audit(guild,title,body){
  const c=cfg(guild.id);const channelId=c.auditChannelId;if(!channelId)return;
  const ch=guild.channels.cache.get(channelId);if(!ch?.isTextBased())return;
  await ch.send({embeds:[new EmbedBuilder().setTitle(title).setDescription(body.slice(0,3900)).setColor(0xed4245).setTimestamp()]}).catch(()=>{});
}
async function inspect(message){
  if(!message?.guild||message.author?.bot)return;
  const links=urlsFromText(message.content||'');if(!links.length)return;
  const reasons=[];
  for(const item of links){const local=localVerdict(item);if(local)reasons.push({url:item.raw,reason:local});}
  const reputationUrls=links.filter(x=>!reasons.some(r=>r.url===x.raw)).map(x=>x.url.href);
  const safe=await reputation(reputationUrls);
  for(const item of links){const v=safe.get(item.url.href);if(v)reasons.push({url:item.raw,reason:`Google Safe Browsing: ${v}`});}
  if(!reasons.length)return;
  await message.delete().catch(()=>{});
  await audit(message.guild,'🚫 Malicious link blocked',`${message.author} • **Channel:** <#${message.channel.id}>\n**Message ID:** \`${message.id}\`\n**Reason:** ${reasons.map(x=>`${x.reason} — \`${x.url}\``).join('\n')}\n**Message:** ${(message.content||'[link/attachment]').slice(0,700).replace(/`/g,'ˋ')}`);
}

const OriginalLogin=Client.prototype.login;
Client.prototype.login=async function(...args){
  if(!this.__linkSecurityInstalled){
    this.__linkSecurityInstalled=true;
    this.on('messageCreate',m=>{void inspect(m).catch(e=>console.error('[link] scan failed:',e?.message||e));});
    this.on('messageUpdate',async(_old,m)=>{try{const fresh=await m.fetch().catch(()=>m);await inspect(fresh);}catch(e){console.error('[link] edit scan failed:',e?.message||e);}});
    if(!GOOGLE_KEY)console.warn('[link] GOOGLE_SAFE_BROWSING_API_KEY is not set; using local high-confidence link/IP-logger detection only.');
  }
  return OriginalLogin.apply(this,args);
};
