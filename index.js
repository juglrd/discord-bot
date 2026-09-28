import 'dotenv/config';
import fs from 'node:fs';
import { Client, GatewayIntentBits, Partials, PermissionsBitField, SlashCommandBuilder, EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, userMention } from 'discord.js';

console.log('[startup] index.js loaded');
console.log('[startup] Node:', process.version);
console.log('[startup] DISCORD_TOKEN configured:', Boolean(process.env.DISCORD_TOKEN));
if (!process.env.DISCORD_TOKEN) { throw new Error('DISCORD_TOKEN is missing from the application environment variables.'); }

process.on('unhandledRejection', e => console.error('[process] unhandledRejection:', e?.stack || e));
process.on('uncaughtException', e => console.error('[process] uncaughtException:', e?.stack || e));
process.on('beforeExit', code => console.error('[process] beforeExit:', code));


const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions], partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User] });
console.log('[startup] Discord client constructed');

const DATA_FILE = './settings.json';
const DEFAULT_PREFIX = "'";
const DEFAULTS = { prefix: DEFAULT_PREFIX, nsfwFilter: true, goreFilter: true, auditChannelId: null, antiInvite: true, antiSpam: true, warnings: {}, strikes: {}, strikeChannelId: null, strikeBoardMessageId: null, commandBlacklist: {}, skullLeaderSince: null };
const STRIKE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const STRIKE_APPEAL_PREFIX = 'strike_appeal:';

function loadData(){ try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch { return {}; } }
const data = globalThis.__juglrdBotSettings ??= loadData();
function saveData(){ try { fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); } catch(e) { console.error('Could not save settings:', e.message); } }
function getConfig(guildId){ if(!data[guildId]) data[guildId]=structuredClone(DEFAULTS); data[guildId]={...DEFAULTS,...data[guildId],warnings:data[guildId].warnings||{},strikes:data[guildId].strikes&&typeof data[guildId].strikes==='object'?data[guildId].strikes:{},commandBlacklist:data[guildId].commandBlacklist&&typeof data[guildId].commandBlacklist==='object'?data[guildId].commandBlacklist:{},skulls:data[guildId].skulls&&typeof data[guildId].skulls==='object'?data[guildId].skulls:{}}; if(typeof data[guildId].prefix!=='string'||!data[guildId].prefix)data[guildId].prefix=DEFAULT_PREFIX; return data[guildId]; }
function isMod(member){ return !!(member?.permissions.has(PermissionsBitField.Flags.ManageGuild)||member?.permissions.has(PermissionsBitField.Flags.ManageMessages)||member?.permissions.has(PermissionsBitField.Flags.Administrator)); }
function canBan(member){ return !!member?.permissions.has(PermissionsBitField.Flags.BanMembers); }
function canManageServer(member){ return !!member?.permissions.has(PermissionsBitField.Flags.ManageGuild); }
const commandGuard = globalThis.__juglrdCommandGuard ??= {
  isBlacklisted(guildId,userId){
    return !!getConfig(guildId).commandBlacklist?.[userId];
  },
  topTwoRoleIds(guild){
    return [...guild.roles.cache.values()]
      .filter(r=>r.id!==guild.id&&!r.managed)
      .sort((a,b)=>b.position-a.position)
      .slice(0,2)
      .map(r=>r.id);
  },
  canControl(member){
    const top=this.topTwoRoleIds(member.guild);
    return top.length>0 && member.roles.cache.some(r=>top.includes(r.id));
  }
};
function commandEmbed(title,description,color=0x5865f2){ return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp(); }
function warningEmbed(target,reason,moderator){
  const safeReason=String(reason||'No reason provided').replace(/\r?\n/g,' ').replace(/`/g,'ˋ').slice(0,800);
  return new EmbedBuilder()
    .setAuthor({name:target.user.username,iconURL:target.user.displayAvatarURL({size:128})})
    .setTitle('Warning')
    .setColor(0x2b2d31)
    .setDescription('> You have successfully warned '+target+'\n> **Reason:** `'+safeReason+'`\n\nDuration: **Indefinite** | By: **'+moderator.username+'**')
    .setTimestamp();
}
function strikeRecord(gid,uid){const c=getConfig(gid);if(!c.strikes[uid])c.strikes[uid]={items:[],history:[],appealThreadId:null};const r=c.strikes[uid];if(!Array.isArray(r.items))r.items=[];if(!Array.isArray(r.history))r.history=[];return r;}
function cleanActiveStrikes(gid,uid){const r=strikeRecord(gid,uid),now=Date.now(),active=[];for(const s of r.items){if(new Date(s.expiresAt).getTime()>now)active.push(s);else if(!r.history.some(x=>x.id===s.id))r.history.push({...s,status:'expired',expiredAt:s.expiresAt});}r.items=active;saveData();return {record:r,active};}
function strikeBoardEmbed(guild){const c=getConfig(guild.id),groups=[];for(const uid of Object.keys(c.strikes||{})){const state=cleanActiveStrikes(guild.id,uid);if(!state.active.length)continue;const lines=state.active.map((s,n)=>{const ts=Math.floor(new Date(s.createdAt).getTime()/1000);return '**#'+(n+1)+'** <t:'+ts+':d> — '+s.reason;}).join('\\n');groups.push({uid,count:state.active.length,lines});}groups.sort((a,b)=>b.count-a.count||a.uid.localeCompare(b.uid));const fields=groups.slice(0,25).map(g=>({name:g.count+' active strike'+(g.count===1?'':'s')+' ⚠️',value:userMention(g.uid)+'\n'+g.lines.slice(0,1000)}));const embed=new EmbedBuilder().setTitle('☆ • Staff Strikeboard • ☆').setColor(0x2b2d31).setDescription(fields.length?'Members with active staff strikes:':'No active staff strikes.').addFields(fields);if(fields.length>=25)embed.setFooter({text:'Showing the first 25 members with active strikes.'});return embed;}
function strikeAppealRow(){return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(STRIKE_APPEAL_PREFIX+'self').setLabel('Create Appeal Thread').setStyle(ButtonStyle.Primary));}
async function updateStrikeBoard(guild){const c=getConfig(guild.id);if(!c.strikeChannelId||!c.strikeBoardMessageId)return;const ch=await guild.channels.fetch(c.strikeChannelId).catch(()=>null);const msg=ch?.isTextBased()?await ch.messages.fetch(c.strikeBoardMessageId).catch(()=>null):null;if(!msg)return;const hasActive=Object.keys(c.strikes||{}).some(uid=>strikeRecord(guild.id,uid).items.length);if(!hasActive){await msg.edit({embeds:[strikeBoardEmbed(guild)],components:[strikeAppealRow()],allowedMentions:{parse:[]}}).catch(()=>{});return;}await msg.edit({embeds:[strikeBoardEmbed(guild)],components:[strikeAppealRow()],allowedMentions:{users:Object.keys(c.strikes||{}).filter(uid=>strikeRecord(guild.id,uid).items.length)}}).catch(()=>{});}
async function cleanupExpiredStrikes(){for(const guild of client.guilds.cache.values()){const c=getConfig(guild.id);let changed=false;for(const uid of Object.keys(c.strikes||{})){const before=strikeRecord(guild.id,uid).items.length;cleanActiveStrikes(guild.id,uid);const after=strikeRecord(guild.id,uid).items.length;if(after<before)changed=true;}if(changed)await updateStrikeBoard(guild).catch(()=>{});}saveData();}

function isSkullReaction(reaction){const name=reaction.emoji?.name;return name==='💀'||String(name||'').toLowerCase()==='skull';}
function getSkulls(gid,uid){const c=getConfig(gid);return Math.max(0,Number(c.skulls[uid]||0));}
function changeSkulls(gid,uid,amount){
  const c=getConfig(gid),next=Math.max(0,getSkulls(gid,uid)+amount);
  if(next===0)delete c.skulls[uid];else c.skulls[uid]=next;
  const leader=Object.entries(c.skulls).map(([id,count])=>({id,count:Number(count)||0})).filter(x=>x.count>0).sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id))[0];
  if(leader){
    if(c.skullLeaderSince?.userId!==leader.id)c.skullLeaderSince={userId:leader.id,since:new Date().toISOString()};
  }else c.skullLeaderSince=null;
  saveData();
  return next;
}
function skullboardEmbed(guild,viewerId){
  const cfg=getConfig(guild.id);
  const fmt=n=>n.toLocaleString('en-US');
  const raw=Object.entries(cfg.skulls)
    .map(([uid,count])=>({uid,count:Number(count)||0}))
    .filter(x=>x.count>0)
    .sort((a,b)=>b.count-a.count||a.uid.localeCompare(b.uid));
  const entries=raw.slice(0,15);
  if(!cfg.skullLeaderSince&&entries[0]){
    cfg.skullLeaderSince={userId:entries[0].uid,since:new Date().toISOString()};
    saveData();
  }
  const medals=['👑','🥈','🥉'];
  const lines=entries.length?entries.map((x,n)=>{
    const prefix=n<3?medals[n]:(n+1)+'.';
    const days=n===0&&cfg.skullLeaderSince?.userId===x.uid
      ?Math.max(0,Math.floor((Date.now()-new Date(cfg.skullLeaderSince.since).getTime())/86400000))
      :0;
    return '**'+prefix+'** <@'+x.uid+'>  •  **'+fmt(x.count)+'**'+(n===0&&days>0?' *(Held for '+days+' day'+(days===1?'':'s')+')*':'');
  }):['No skulls have been recorded yet.'];
  const position=viewerId?(raw.findIndex(x=>x.uid===viewerId)+1):0;
  const posText=position>0
    ?'Your Position: #'+position+' ('+fmt(raw[position-1].count)+' skull'+(raw[position-1].count===1?'':'s')+')'
    :'Your Position: **Unranked**';
  return new EmbedBuilder()
    .setTitle('💀 Skull Leaderboard')
    .setDescription('Users with the most skulls received on their messages.\n\n'+lines.join('\n'))
    .setColor(0x2b2d31)
    .setFooter({text:posText});
}
async function commandLog(message,name,args,result='used'){
  const cfg=getConfig(message.guild.id);
  if(!cfg.auditChannelId)return;
  const ch=message.guild.channels.cache.get(cfg.auditChannelId);
  if(!ch?.isTextBased())return;
  const text=[`**User:** ${message.author} (${message.author.id})`,`**Channel:** <#${message.channel.id}>`,`**Command:** ${cfg.prefix||DEFAULT_PREFIX}${name}${args.length?' '+args.join(' '):''}`,`**Result:** ${result}`].join('\\n');
  await ch.send({embeds:[commandEmbed('📋 Command used',text,0x5865f2)]}).catch(()=>{});
}
async function interactionLog(interaction,name,result='used'){
  const cfg=getConfig(interaction.guild.id);
  if(!cfg.auditChannelId)return;
  const ch=interaction.guild.channels.cache.get(cfg.auditChannelId);
  if(!ch?.isTextBased())return;
  const text=['**User:** '+interaction.user+' ('+interaction.user.id+')','**Channel:** <#'+interaction.channelId+'>','**Command:** /'+name,'**Result:** '+result].join('\\n');
  await ch.send({embeds:[commandEmbed('📋 Command used',text,0x5865f2)]}).catch(()=>{});
}
function prefixFor(guildId){ return getConfig(guildId).prefix || DEFAULT_PREFIX; }
function parseDuration(input){ const m=String(input||'').match(/^(\d+)(s|m|h|d)$/i); return m ? Number(m[1])*({s:1000,m:60000,h:3600000,d:86400000}[m[2].toLowerCase()]) : null; }
function formatDuration(ms){ for(const [u,v] of [['d',86400000],['h',3600000],['m',60000],['s',1000]]) if(ms>=v)return `${Math.round(ms/v)}${u}`; return '0s'; }
function helpText(prefix){ return `**Moderation commands**\n\`${prefix}help\` • commands\n\`${prefix}nsfw on/off\` • NSFW filter\n\`${prefix}gore on/off\` • gore filter\n\`${prefix}prefix <new>\` • change prefix\n\`${prefix}setlogs #channel\` • audit logs\n\`${prefix}config\` • protection settings\n\`${prefix}warn @user [reason]\`\n\`${prefix}warnings @user\`\n\`${prefix}clearwarnings @user\`\n\`${prefix}timeout @user 10m [reason]\`\n\`${prefix}kick @user [reason]\`\n\`${prefix}ban @user [reason]\`\n\`${prefix}lock\` / \`${prefix}unlock\`\n\`${prefix}slowmode 10\`\n\`${prefix}antiinvite on/off\`\n\`${prefix}antispam on/off\`\n\`${prefix}blacklist add/remove @user\` • command blacklist\n`/skulls [user]` • skull count`; }
async function executeCommand(message,name,args){
  const cfg=getConfig(message.guild.id), prefix=cfg.prefix||DEFAULT_PREFIX;
  const filterCommands=['prefix','nsfw','gore','setlogs','config','antiinvite','antispam'];
  const moderationCommands=['warn','warnings','clearwarnings','timeout','kick','ban','lock','unlock','slowmode'];
  await commandLog(message,name,args);
  if(filterCommands.includes(name)&&!canManageServer(message.member)) return message.reply({embeds:[commandEmbed('🔒 Permission denied','You need **Manage Server** to use this command.',0xed4245)]});
  if(moderationCommands.includes(name)&&!canBan(message.member)) return message.reply({embeds:[commandEmbed('🔒 Permission denied','You need **Ban Members** to use moderation commands.',0xed4245)]});
  if(name==='blacklist'){
    if(!commandGuard.canControl(message.member)) return message.reply({embeds:[commandEmbed('🔒 Permission denied',"Only the server's top 2 roles can use the command blacklist.",0xed4245)]});
    const action=args[0]?.toLowerCase();
    const target=message.mentions.users.first();
    if(!['add','remove'].includes(action)||!target) return message.reply({embeds:[commandEmbed('📛 Command blacklist','Usage: /blacklist add @user or /blacklist remove @user',0xed4245)]});
    if(target.bot) return message.reply({embeds:[commandEmbed('📛 Command blacklist','Bot accounts cannot be command blacklisted.',0xed4245)]});
    if(action==='add'){
      cfg.commandBlacklist[target.id]={by:message.author.id,at:new Date().toISOString()};
      saveData();
      return message.reply({embeds:[commandEmbed('📛 Command blacklist','<@'+target.id+'> can no longer use this bot\'s commands.',0xed4245)]});
    }
    delete cfg.commandBlacklist[target.id];
    saveData();
    return message.reply({embeds:[commandEmbed('✅ Command access restored','<@'+target.id+'> can use this bot\'s commands again.',0x57f287)]});
  }
  if(name==='help') return message.reply({embeds:[commandEmbed('📖 Commands',helpText(prefix))]});
  if(name==='prefix'){ const next=args[0]; if(!next||next.length>3||/\s/.test(next)||next.startsWith('/')) return message.reply({embeds:[commandEmbed('⚙️ Prefix','Usage: `'+prefix+'prefix <1-3 non-space characters>`',0xed4245)]}); cfg.prefix=next; saveData(); return message.reply({embeds:[commandEmbed('⚙️ Prefix changed','Prefix is now `'+next+'`. Use `'+next+'help` for commands.',0x57f287)]}); }
  if(['nsfw','gore','antiinvite','antispam'].includes(name)){ const value=args[0]?.toLowerCase(); if(!['on','off'].includes(value)) return message.reply({embeds:[commandEmbed('⚙️ Invalid option','Usage: `'+prefix+name+' on/off`',0xed4245)]}); const key=name==='nsfw'?'nsfwFilter':name==='gore'?'goreFilter':name; cfg[key]=value==='on'; saveData(); return message.reply({embeds:[commandEmbed('🛡️ Filter updated',`**${name.toUpperCase()}** is now **${value}**.`,0x57f287)]}); }
  if(name==='setlogs'){ const ch=message.mentions.channels.first(); if(!ch||ch.type!==ChannelType.GuildText)return message.reply({embeds:[commandEmbed('📋 Audit logs','Usage: `'+prefix+'setlogs #channel`',0xed4245)]}); cfg.auditChannelId=ch.id; saveData(); return message.reply({embeds:[commandEmbed('📋 Audit logs enabled',`Commands and moderation events will be logged to ${ch}.`,0x57f287)]}); }
  if(name==='config') return message.reply({embeds:[new EmbedBuilder().setTitle('🛡️ Server protection').setColor(0x5865f2).setTimestamp().addFields({name:'Prefix',value:`\`${prefix}\``,inline:true},{name:'NSFW',value:cfg.nsfwFilter?'🟢 On':'🔴 Off',inline:true},{name:'Gore',value:cfg.goreFilter?'🟢 On':'🔴 Off',inline:true},{name:'Anti-spam/flood',value:cfg.antiSpam?'🟢 On':'🔴 Off',inline:true},{name:'Anti-invite',value:cfg.antiInvite?'🟢 On':'🔴 Off',inline:true})]});
  const target=message.mentions.members.first();
  if(['warn','warnings','clearwarnings','timeout','kick','ban'].includes(name)&&!target)return message.reply({embeds:[commandEmbed('❌ Missing member','Mention a member. Example: `'+prefix+name+' @user`',0xed4245)]});
  if(name==='warn'){const reason=args.slice(1).join(' ')||'No reason provided';cfg.warnings[target.id]??=[];cfg.warnings[target.id].push({reason,moderator:message.author.id,at:new Date().toISOString()});saveData();return message.reply({embeds:[warningEmbed(target,reason,message.author)]});}
  if(name==='warnings'){const w=cfg.warnings[target.id]||[];return message.reply(w.length?`**Warnings for ${target}:**\n${w.map((x,i)=>`${i+1}. ${x.reason}`).join('\n')}`:`✅ ${target} has no warnings.`);}
  if(name==='clearwarnings'){delete cfg.warnings[target.id];saveData();return message.reply({embeds:[commandEmbed('🧹 Warnings cleared',`Cleared warnings for ${target}.`,0x57f287)]});}
  if(name==='timeout'){const ms=parseDuration(args[1]);if(!ms)return message.reply(`Usage: \`${prefix}timeout @user 10m [reason]\``);await target.timeout(Math.min(ms,28*86400000),args.slice(2).join(' ')||'No reason provided');return message.reply({embeds:[commandEmbed('⏱️ Member timed out','Timed out '+target+' for **'+formatDuration(ms)+'**.',0x57f287)]});}
  if(name==='kick'){await target.kick(args.slice(1).join(' ')||'No reason provided');return message.reply({embeds:[commandEmbed('👢 Member kicked',`Kicked **${target.user.tag}**.`,0x57f287)]});}
  if(name==='ban'){await target.ban({reason:args.slice(1).join(' ')||'No reason provided'});return message.reply({embeds:[commandEmbed('🔨 Member banned',`Banned **${target.user.tag}**.`,0xed4245)]});}
  if(name==='lock'||name==='unlock'){const locked=name==='lock';await message.channel.permissionOverwrites.edit(message.guild.roles.everyone,{SendMessages:!locked});return message.reply({embeds:[commandEmbed(locked?'🔒 Channel locked':'🔓 Channel unlocked',`${locked?'Locked':'Unlocked'} ${message.channel}.`,0x57f287)]});}
  if(name==='slowmode'){const seconds=Number(args[0]);if(!Number.isInteger(seconds)||seconds<0||seconds>21600)return message.reply({embeds:[commandEmbed('🐢 Slowmode','Enter slowmode seconds from 0 to 21600.',0xed4245)]});await message.channel.setRateLimitPerUser(seconds);return message.reply({embeds:[commandEmbed('🐢 Slowmode updated',`Slowmode set to **${seconds}s**.`,0x57f287)]});}
}

const slashCommands=[
 new SlashCommandBuilder().setName('help').setDescription('Show moderation commands'),
 new SlashCommandBuilder().setName('nsfw').setDescription('Toggle NSFW filter').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
 new SlashCommandBuilder().setName('gore').setDescription('Toggle gore filter').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
 new SlashCommandBuilder().setName('setlogs').setDescription('Set audit log channel').addChannelOption(o=>o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
 new SlashCommandBuilder().setName('config').setDescription('View protection settings'),
 new SlashCommandBuilder().setName('prefix').setDescription('Change server prefix').addStringOption(o=>o.setName('value').setDescription('1-3 characters').setRequired(true)),
 new SlashCommandBuilder().setName('warn').setDescription('Warn member').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')),
 new SlashCommandBuilder().setName('warnings').setDescription('View warnings').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
 new SlashCommandBuilder().setName('clearwarnings').setDescription('Clear warnings').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
 new SlashCommandBuilder().setName('timeout').setDescription('Timeout member').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('duration').setDescription('e.g. 10m').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')),
 new SlashCommandBuilder().setName('kick').setDescription('Kick member').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')),
 new SlashCommandBuilder().setName('ban').setDescription('Ban member').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')),
 new SlashCommandBuilder().setName('lock').setDescription('Lock current channel'),
 new SlashCommandBuilder().setName('unlock').setDescription('Unlock current channel'),
 new SlashCommandBuilder().setName('slowmode').setDescription('Set slowmode').addIntegerOption(o=>o.setName('seconds').setDescription('0-21600').setMinValue(0).setMaxValue(21600).setRequired(true)),
 new SlashCommandBuilder().setName('antiinvite').setDescription('Toggle invite blocking').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
 new SlashCommandBuilder().setName('antispam').setDescription('Toggle anti-spam').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
 new SlashCommandBuilder().setName('modpanel').setDescription('Open moderation dashboard'),
 new SlashCommandBuilder().setName('modstats').setDescription('Show moderation statistics'),
 new SlashCommandBuilder().setName('history').setDescription('Show a member moderation history').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
 new SlashCommandBuilder().setName('why').setDescription('Explain recent moderation detections').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
 new SlashCommandBuilder().setName('strike').setDescription('Give a 30-day staff strike').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true)),
 new SlashCommandBuilder().setName('strikesetup').setDescription('Set up the strike system in this channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
 new SlashCommandBuilder().setName('removestrike').setDescription('Remove an active strike').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addIntegerOption(o=>o.setName('number').setDescription('Strike number').setMinValue(1).setRequired(true)),
 new SlashCommandBuilder().setName('paststrikes').setDescription('View a member\'s past strikes').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
 new SlashCommandBuilder().setName('skulls').setDescription('Show skull count').addUserOption(o=>o.setName('user').setDescription('User to check').setRequired(false)),
 new SlashCommandBuilder().setName('skullboard').setDescription('Show the top 10 skulls'),
 new SlashCommandBuilder().setName('addskulls').setDescription('Add skulls to a user').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addUserOption(o=>o.setName('user').setDescription('User receiving skulls').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Amount to add').setMinValue(1).setMaxValue(100000).setRequired(true)),
 new SlashCommandBuilder().setName('removeskulls').setDescription('Remove skulls from a user').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addUserOption(o=>o.setName('user').setDescription('User losing skulls').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Amount to remove').setMinValue(1).setMaxValue(100000).setRequired(true)),
 new SlashCommandBuilder().setName('blacklist').setDescription("Block or unblock a user from using this bot's commands").addSubcommand(s=>s.setName('add').setDescription('Block a user').addUserOption(o=>o.setName('user').setDescription('User to block').setRequired(true))).addSubcommand(s=>s.setName('remove').setDescription('Allow a user again').addUserOption(o=>o.setName('user').setDescription('User to unblock').setRequired(true))),
 new SlashCommandBuilder().setName('channelmode').setDescription('Set detection mode for this channel').addStringOption(o=>o.setName('mode').setDescription('Detection mode').setRequired(true).addChoices({name:'normal',value:'normal'},{name:'strict',value:'strict'},{name:'media',value:'media'},{name:'off',value:'off'}))
].map(c=>c.toJSON());

client.once('ready',async()=>{console.log(`Logged in as ${client.user.tag}`);
  try{const {installModeration}=await import('./moderation-preload.js');installModeration(client);}catch(e){console.error('[startup] moderation module failed:',e?.stack||e);}
  try{const {installLinkSecurity}=await import('./link-security-preload.js');installLinkSecurity(client);}catch(e){console.error('[startup] link security module failed:',e?.stack||e);} await cleanupExpiredStrikes(); setInterval(()=>cleanupExpiredStrikes().catch(e=>console.error('Strike cleanup failed:',e?.message||e)),60000);try{await client.application.commands.set([]);console.log('Global slash commands cleared');for(const guild of client.guilds.cache.values()){try{const registered=await guild.commands.set(slashCommands);console.log(`Guild slash commands registered in ${guild.id}: ${registered.size}`);}catch(e){console.error(`Guild slash command registration failed in ${guild.id}:`,e?.message||e);}}}catch(e){console.error('Slash command registration failed:',e?.stack||e?.message||e);}});
client.on('messageCreate',async message=>{if(!message.inGuild()||message.author.bot)return;const cfg=getConfig(message.guild.id);try{const prefix=cfg.prefix||DEFAULT_PREFIX;if(message.content.startsWith(prefix)){const parts=message.content.slice(prefix.length).trim().split(/\s+/);const name=parts[0]?.toLowerCase();if(commandGuard.isBlacklisted(message.guild.id,message.author.id)&&name!=='blacklist')return message.reply({content:"❌ You are command blacklisted and cannot use this bot's commands."}).catch(()=>{});parts.shift();if(name)await executeCommand(message,name,parts).catch(e=>console.error('Prefix command failed:',e?.message||e));}}catch(e){console.error('Message handler failed:',e?.message||e);}});
client.on('messageReactionAdd',async(reaction,user)=>{if(user.bot||!isSkullReaction(reaction))return;try{if(reaction.partial)await reaction.fetch();const message=reaction.message;if(!message?.guild||!message.author||message.author.bot)return;changeSkulls(message.guild.id,message.author.id,1);}catch(e){console.error('Skull reaction add failed:',e?.message||e);}});
client.on('messageReactionRemove',async(reaction,user)=>{if(user.bot||!isSkullReaction(reaction))return;try{if(reaction.partial)await reaction.fetch();const message=reaction.message;if(!message?.guild||!message.author||message.author.bot)return;changeSkulls(message.guild.id,message.author.id,-1);}catch(e){console.error('Skull reaction remove failed:',e?.message||e);}});
client.on('interactionCreate',async i=>{
  if(!i.inGuild())return;

  if(i.isChatInputCommand()&&i.commandName!=='blacklist'&&commandGuard.isBlacklisted(i.guild.id,i.user.id))return i.reply({content:"❌ You are command blacklisted and cannot use this bot's commands.",ephemeral:true}).catch(()=>{});

  // Acknowledge /skullboard immediately before any async leaderboard work.
  if(i.isChatInputCommand()&&i.commandName==='skullboard'){
    try{
      await i.reply({embeds:[skullboardEmbed(i.guild,i.user.id)],allowedMentions:{users:[]}});
    }catch(e){
      console.error('Skullboard interaction failed:',e?.stack||e?.message||e);
      if(!i.replied&&!i.deferred)await i.reply({content:'❌ Something went wrong while loading the skull leaderboard.',ephemeral:true}).catch(()=>{});
    }
    return;
  }

  // Handle /skulls before config, logging, or member fetches.
  if(i.isChatInputCommand()&&i.commandName==='skulls'){
    try{
      const targetUser=i.options.getUser('user')||i.user;
      const count=getSkulls(i.guild.id,targetUser.id);
      await i.reply({
        content:userMention(targetUser.id)+' you have **'+count+'** skull'+(count===1?'':'s')+' 💀',
        allowedMentions:{users:[targetUser.id]}
      });
    }catch(e){
      console.error('Skulls command failed:',e?.stack||e?.message||e);
      if(!i.replied&&!i.deferred)await i.reply({content:'❌ Something went wrong while checking skulls.',ephemeral:true}).catch(()=>{});
    }
    return;
  }

  const cfg=getConfig(i.guild.id);
  const filterCommands=['prefix','nsfw','gore','setlogs','config','antiinvite','antispam'];
  const moderationCommands=['warn','warnings','clearwarnings','timeout','kick','ban','lock','unlock','slowmode'];
  const advancedCommands=['modpanel','modstats','history','why','channelmode'];
  if(advancedCommands.includes(i.commandName)){
    const handler=globalThis.__juglrdModerationInteractionHandler;
    if(typeof handler==='function')return handler(i);
    return i.reply({content:'❌ Moderation systems are still loading. Please try again in a moment.',ephemeral:true}).catch(()=>{});
  }
  const handledCommands=new Set(['help','strike','strikesetup','removestrike','paststrikes','skulls','skullboard','addskulls','removeskulls','blacklist',...filterCommands,...moderationCommands]);
  const replyError=async e=>{
    console.error('Interaction failed:',e?.stack||e?.message||e);
    if(!i.replied&&!i.deferred)await i.reply({embeds:[commandEmbed('❌ Error','Something went wrong.',0xed4245)],ephemeral:true}).catch(()=>{});
  };
  try{
    if(i.isButton()&&i.customId.startsWith(STRIKE_APPEAL_PREFIX)){
      const userId=i.user.id;
      const state=cleanActiveStrikes(i.guild.id,userId);
      if(!state.active.length)return i.reply({content:'❌ You do not have any active strikes to appeal.',ephemeral:true});
      if(state.record.appealThreadId){
        const existing=await i.guild.channels.fetch(state.record.appealThreadId).catch(()=>null);
        if(existing)return i.reply({content:'An appeal thread already exists: <#'+existing.id+'>',ephemeral:true});
        state.record.appealThreadId=null;
      }
      if(!i.channel?.isTextBased()||!i.channel.threads)return i.reply({content:'❌ Appeals must be created from a normal text-channel strikeboard.',ephemeral:true});
      const thread=await i.channel.threads.create({name:'Strike appeal — '+i.user.username,autoArchiveDuration:1440,type:ChannelType.PrivateThread,invitable:false,reason:'Staff strike appeal'});
      await thread.members.add(userId);
      await thread.send({content:'<@'+userId+'> Please explain why you believe your strike was given falsely. This appeal is private; only you and staff with **Manage Threads** can view it.'});
      state.record.appealThreadId=thread.id;
      saveData();
      return i.reply({content:'✅ Private appeal thread created: <#'+thread.id+'>',ephemeral:true});
    }
    if(!i.isChatInputCommand())return;
    if(!handledCommands.has(i.commandName))return i.reply({embeds:[commandEmbed('❌ Command unavailable','Unrecognized slash command.',0xed4245)],ephemeral:true}).catch(()=>{});
    interactionLog(i,i.commandName).catch(()=>{});


    if(i.commandName==='addskulls'){
      if(!commandGuard.canControl(i.member))return i.reply({content:"❌ Only the server's top 2 roles can use this command.",ephemeral:true});
      const target=i.options.getUser('user',true),amount=i.options.getInteger('amount',true);
      if(target.bot)return i.reply({content:'❌ Bot accounts cannot have skulls.',ephemeral:true});
      const total=changeSkulls(i.guild.id,target.id,amount);
      const embed=new EmbedBuilder().setTitle('💀 Skulls added').setColor(0x57f287).setDescription('<@'+target.id+'> received **'+amount+'** skull'+(amount===1?'':'s')+'.').addFields({name:'New total',value:'**'+total+'** 💀',inline:true}).setThumbnail(target.displayAvatarURL({size:128})).setTimestamp();
      return i.reply({embeds:[embed],allowedMentions:{users:[target.id]}});
    }

    if(i.commandName==='removeskulls'){
      if(!commandGuard.canControl(i.member))return i.reply({content:"❌ Only the server's top 2 roles can use this command.",ephemeral:true});
      const target=i.options.getUser('user',true),amount=i.options.getInteger('amount',true);
      if(target.bot)return i.reply({content:'❌ Bot accounts cannot have skulls.',ephemeral:true});
      const before=getSkulls(i.guild.id,target.id),total=changeSkulls(i.guild.id,target.id,-amount),removed=before-total;
      const embed=new EmbedBuilder().setTitle('💀 Skulls removed').setColor(0xed4245).setDescription('<@'+target.id+'> lost **'+removed+'** skull'+(removed===1?'':'s')+'.').addFields({name:'New total',value:'**'+total+'** 💀',inline:true}).setThumbnail(target.displayAvatarURL({size:128})).setTimestamp();
      return i.reply({embeds:[embed],allowedMentions:{users:[target.id]}});
    }



    if(i.commandName==='blacklist'){
      if(!commandGuard.canControl(i.member))return i.reply({content:"❌ Only the server's top 2 roles can use the command blacklist.",ephemeral:true});
      const action=i.options.getSubcommand();
      const target=i.options.getUser('user',true);
      if(target.bot)return i.reply({content:'❌ Bot accounts cannot be command blacklisted.',ephemeral:true});
      if(action==='add'){
        cfg.commandBlacklist[target.id]={by:i.user.id,at:new Date().toISOString()};
        saveData();
        return i.reply({content:'📛 <@'+target.id+'> is now command blacklisted. They cannot use this bot\'s commands.',allowedMentions:{users:[target.id]}});
      }
      delete cfg.commandBlacklist[target.id];
      saveData();
      return i.reply({content:'✅ Command access restored for <@'+target.id+'>.',allowedMentions:{users:[target.id]}});
    }

    if(filterCommands.includes(i.commandName)&&!canManageServer(i.member))
      return i.reply({embeds:[commandEmbed('🔒 Permission denied','You need **Manage Server** to use this command.',0xed4245)],ephemeral:true});

    if(moderationCommands.includes(i.commandName)&&!canBan(i.member))
      return i.reply({embeds:[commandEmbed('🔒 Permission denied','You need **Ban Members** to use moderation commands.',0xed4245)],ephemeral:true});

    if(['strikesetup','removestrike','paststrikes'].includes(i.commandName)&&!canManageServer(i.member))return i.reply({content:'❌ You need **Manage Server** to use this command.',ephemeral:true});

    if(i.commandName==='strike'&&!canManageServer(i.member))
      return i.reply({embeds:[commandEmbed('🔒 Permission denied','You need **Manage Server** to use this command.',0xed4245)],ephemeral:true});

    if(i.commandName==='help')
      return i.reply({embeds:[commandEmbed('📖 Commands',helpText(cfg.prefix||DEFAULT_PREFIX))]});

    if(i.commandName==='prefix'){
      const p=i.options.getString('value');
      if(!p||p.length>3||/\s/.test(p)||p.startsWith('/'))
        return i.reply({embeds:[commandEmbed('⚙️ Invalid prefix','Prefix must be 1-3 non-space characters and cannot start with /.',0xed4245)],ephemeral:true});
      cfg.prefix=p;saveData();
      return i.reply({embeds:[commandEmbed('⚙️ Prefix changed','Prefix is now '+p+'.',0x57f287)]});
    }

    if(['nsfw','gore','antiinvite','antispam'].includes(i.commandName)){
      const state=i.options.getString('state');
      const key=i.commandName==='nsfw'?'nsfwFilter':i.commandName==='gore'?'goreFilter':'antiSpam';
      cfg[key]=state==='on';saveData();
      return i.reply({embeds:[commandEmbed('🛡️ Filter updated','**'+i.commandName.toUpperCase()+'** is now **'+state+'**.',0x57f287)]});
    }

    if(i.commandName==='setlogs'){
      const ch=i.options.getChannel('channel');
      if(!ch?.isTextBased())return i.reply({embeds:[commandEmbed('📋 Audit logs','Choose a text channel.',0xed4245)],ephemeral:true});
      cfg.auditChannelId=ch.id;saveData();
      return i.reply({embeds:[commandEmbed('📋 Audit logs enabled','Commands and moderation events will be logged to '+ch+'.',0x57f287)]});
    }

    if(i.commandName==='config')
      return i.reply({embeds:[new EmbedBuilder().setTitle('🛡️ Server protection').setColor(0x5865f2).setTimestamp()
        .addFields(
          {name:'Prefix',value:cfg.prefix,inline:true},
          {name:'NSFW',value:cfg.nsfwFilter?'🟢 On':'🔴 Off',inline:true},
          {name:'Gore',value:cfg.goreFilter?'🟢 On':'🔴 Off',inline:true},
          {name:'Anti-spam/flood',value:cfg.antiSpam?'🟢 On':'🔴 Off',inline:true},
          {name:'Anti-invite',value:cfg.antiInvite?'🟢 On':'🔴 Off',inline:true}
        )]});

    const user=i.options.getUser('user');
    const target=user?await i.guild.members.fetch(user.id).catch(()=>null):null;

    if(['warn','warnings','clearwarnings','timeout','kick','ban'].includes(i.commandName)&&!target)
      return i.reply({embeds:[commandEmbed('❌ Missing member','That user is not currently in this server.',0xed4245)],ephemeral:true});

    if(i.commandName==='strikesetup'){
      if(!i.channel?.isTextBased()||!i.channel.threads)return i.reply({content:'❌ Use this command in a normal text channel.',ephemeral:true});
      cfg.strikeChannelId=i.channel.id;
      let board=null;
      if(cfg.strikeBoardMessageId){
        board=await i.channel.messages.fetch(cfg.strikeBoardMessageId).catch(()=>null);
      }
      if(board){
        await board.edit({embeds:[strikeBoardEmbed(i.guild)],components:[strikeAppealRow()],allowedMentions:{parse:[]}});
      }else{
        board=await i.channel.send({embeds:[strikeBoardEmbed(i.guild)],components:[strikeAppealRow()],allowedMentions:{parse:[]}});
        cfg.strikeBoardMessageId=board.id;
      }
      saveData();
      return i.reply({content:'✅ Staff strike system set up. The strikeboard has been created/updated above.',ephemeral:true});
    }

    if(i.commandName==='removestrike'){
      const target=i.options.getUser('user',true),number=i.options.getInteger('number',true);
      const state=cleanActiveStrikes(i.guild.id,target.id);
      const removed=state.active[number-1];
      if(!removed)return i.reply({content:'❌ That active strike number does not exist.',ephemeral:true});
      state.record.items=state.active.filter((_,n)=>n!==number-1);
      state.record.history.push({...removed,status:'removed',removedAt:new Date().toISOString(),removedBy:i.user.id});
      saveData();
      await updateStrikeBoard(i.guild);
      return i.reply({content:'✅ Removed strike **#'+number+'** from '+target+'.',ephemeral:true});
    }

    if(i.commandName==='paststrikes'){
      const target=i.options.getUser('user',true);
      const state=cleanActiveStrikes(i.guild.id,target.id);
      const history=state.record.history.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
      if(!history.length)return i.reply({content:'📜 '+target+' has no past strikes.',ephemeral:true});
      const lines=history.slice(0,15).map((s,n)=>{
        const ts=Math.floor(new Date(s.createdAt).getTime()/1000);
        const status=s.status==='removed'?'Removed':'Expired';
        return '**'+(n+1)+'.** <t:'+ts+':d> • **'+status+'**\\n> '+s.reason+'\\n> Issued by <@'+s.moderatorId+'>';
      });
      return i.reply({embeds:[new EmbedBuilder().setTitle('📜 Past Strikes').setColor(0x2b2d31).setDescription('Strike history for '+target+'\\n\\n'+lines.join('\\n\\n')).setFooter({text:'Showing up to 15 past strikes'})],ephemeral:true,allowedMentions:{users:[]}}); 
    }

    if(i.commandName==='strike'){
      const target=i.options.getMember('user')||await i.guild.members.fetch(i.options.getUser('user',true).id).catch(()=>null);
      if(!target)return i.reply({content:'❌ That user is not currently in this server.',ephemeral:true});
      const reason=String(i.options.getString('reason')||'No reason provided').replace(/\\r?\\n/g,' ').replace(/@/g,'@\\u200b').slice(0,500);
      const state=cleanActiveStrikes(i.guild.id,target.id);
      const now=new Date();
      state.active.push({id:Date.now()+'-'+i.id,reason,moderatorId:i.user.id,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+STRIKE_DURATION_MS).toISOString()});
      state.record.items=state.active;
      state.record.appealThreadId=null;
      saveData();
      await updateStrikeBoard(i.guild);
      return i.reply({content:'✅ Strike added to '+target+'.',ephemeral:true});
    }

    if(i.commandName==='warn'){
      const reason=i.options.getString('reason')||'No reason provided';
      cfg.warnings[target.id]??=[];
      cfg.warnings[target.id].push({reason,moderator:i.user.id,at:new Date().toISOString()});
      saveData();
      return i.reply({embeds:[warningEmbed(target,reason,i.user)]});
    }

    if(i.commandName==='warnings'){
      const w=cfg.warnings[target.id]||[];
      return i.reply(w.length
        ? '**Warnings for '+target+':**\n'+w.map((x,n)=>(n+1)+'. '+x.reason).join('\n')
        : '✅ '+target+' has no warnings.');
    }

    if(i.commandName==='clearwarnings'){
      delete cfg.warnings[target.id];saveData();
      return i.reply({embeds:[commandEmbed('🧹 Warnings cleared','Cleared warnings for '+target+'.',0x57f287)]});
    }

    if(i.commandName==='timeout'){
      const duration=i.options.getString('duration');
      const ms=parseDuration(duration);
      if(!ms)return i.reply({embeds:[commandEmbed('⏱️ Invalid duration','Use a duration like 10m, 2h, or 1d.',0xed4245)],ephemeral:true});
      const actual=Math.min(ms,28*86400000);
      const reason=i.options.getString('reason')||'No reason provided';
      await target.timeout(actual,reason);
      return i.reply({embeds:[commandEmbed('⏱️ Member timed out','Timed out '+target+' for '+formatDuration(actual)+'.',0x57f287)]});
    }

    if(i.commandName==='kick'){
      await target.kick(i.options.getString('reason')||'No reason provided');
      return i.reply({embeds:[commandEmbed('👢 Member kicked','Kicked '+target.user.tag+'.',0x57f287)]});
    }

    if(i.commandName==='ban'){
      await target.ban({reason:i.options.getString('reason')||'No reason provided'});
      return i.reply({embeds:[commandEmbed('🔨 Member banned','Banned '+target.user.tag+'.',0xed4245)]});
    }

    if(i.commandName==='lock'||i.commandName==='unlock'){
      const locked=i.commandName==='lock';
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:!locked});
      return i.reply({embeds:[commandEmbed(locked?'🔒 Channel locked':'🔓 Channel unlocked',(locked?'Locked ':'Unlocked ')+i.channel+'.',0x57f287)]});
    }

    if(i.commandName==='slowmode'){
      const seconds=i.options.getInteger('seconds');
      await i.channel.setRateLimitPerUser(seconds);
      return i.reply({embeds:[commandEmbed('🐢 Slowmode updated','Slowmode set to '+seconds+'s.',0x57f287)]});
    }

  }catch(e){await replyError(e);}
});

await client.login(process.env.DISCORD_TOKEN);
console.log('[startup] Discord login successful');
process.on('exit',code=>console.error('[startup] Process exiting with code:',code));
