import 'dotenv/config';
import fs from 'node:fs';
import { Client, GatewayIntentBits, Partials, PermissionsBitField, SlashCommandBuilder, EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

if (!process.env.DISCORD_TOKEN) { console.error('Missing DISCORD_TOKEN in environment variables.'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions], partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User] });
const DATA_FILE = './settings.json';
const DEFAULT_PREFIX = "'";
const DEFAULTS = { prefix: DEFAULT_PREFIX, nsfwFilter: true, goreFilter: true, piiFilter: true, auditChannelId: null, antiInvite: true, antiSpam: true, warnings: {}, strikes: {} };
const STRIKE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const STRIKE_APPEAL_PREFIX = 'strike_appeal:';

function loadData(){ try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch { return {}; } }
const data = globalThis.__juglrdBotSettings ??= loadData();
function saveData(){ try { fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); } catch(e) { console.error('Could not save settings:', e.message); } }
function getConfig(guildId){ if(!data[guildId]) data[guildId]=structuredClone(DEFAULTS); data[guildId]={...DEFAULTS,...data[guildId],warnings:data[guildId].warnings||{},strikes:data[guildId].strikes&&typeof data[guildId].strikes==='object'?data[guildId].strikes:{},skulls:data[guildId].skulls&&typeof data[guildId].skulls==='object'?data[guildId].skulls:{}}; if(typeof data[guildId].prefix!=='string'||!data[guildId].prefix)data[guildId].prefix=DEFAULT_PREFIX; return data[guildId]; }
function isMod(member){ return !!(member?.permissions.has(PermissionsBitField.Flags.ManageGuild)||member?.permissions.has(PermissionsBitField.Flags.ManageMessages)||member?.permissions.has(PermissionsBitField.Flags.Administrator)); }
function canBan(member){ return !!member?.permissions.has(PermissionsBitField.Flags.BanMembers); }
function canManageServer(member){ return !!member?.permissions.has(PermissionsBitField.Flags.ManageGuild); }
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
function strikeRecord(gid,uid){const c=getConfig(gid);if(!c.strikes[uid])c.strikes[uid]={items:[],channelId:null,messageId:null};const r=c.strikes[uid];if(!Array.isArray(r.items))r.items=[];return r;}
function cleanActiveStrikes(gid,uid){const r=strikeRecord(gid,uid),now=Date.now(),active=r.items.filter(s=>new Date(s.expiresAt).getTime()>now);if(active.length!==r.items.length){r.items=active;saveData();}if(!active.length){r.channelId=null;r.messageId=null;}return {record:r,active};}
function strikeEmbed(target,active){let lines=active.map((s,n)=>{const ts=Math.floor(new Date(s.createdAt).getTime()/1000);return '> **'+(n+1)+'.** <t:'+ts+':d>: '+s.reason;}).join('\n')||'> No active strikes.';return new EmbedBuilder().setAuthor({name:target.user.username,iconURL:target.user.displayAvatarURL({size:128})}).setTitle('☆ • Staff Strikeboard • ☆').setColor(0x2b2d31).setDescription('If you believe your strike was given falsely, you may appeal by clicking the button below.\n(Otherwise, you can wait until the strike expires after 30 days.)\n\n'+target+' ('+active.length+' strike'+(active.length===1?'':'s')+'⚠️)\n\n'+lines).setTimestamp();}
function strikeAppealRow(uid){return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(STRIKE_APPEAL_PREFIX+uid).setLabel('Create Appeal Thread').setStyle(ButtonStyle.Primary));}
async function updateStrikeBoard(guild,uid){const {record,active}=cleanActiveStrikes(guild.id,uid);if(!record.messageId||!record.channelId)return;const ch=await guild.channels.fetch(record.channelId).catch(()=>null);const msg=ch?.isTextBased()?await ch.messages.fetch(record.messageId).catch(()=>null):null;if(!msg)return;if(!active.length){await msg.delete().catch(()=>{});delete getConfig(guild.id).strikes[uid];saveData();return;}const member=await guild.members.fetch(uid).catch(()=>null);if(!member)return;await msg.edit({embeds:[strikeEmbed(member,active)],components:[strikeAppealRow(uid)]}).catch(()=>{});}
async function cleanupExpiredStrikes(){for(const guild of client.guilds.cache.values()){const c=getConfig(guild.id);for(const uid of Object.keys(c.strikes||{})){const before=strikeRecord(guild.id,uid).items.length;cleanActiveStrikes(guild.id,uid);const after=strikeRecord(guild.id,uid).items.length;if(after<before)await updateStrikeBoard(guild,uid).catch(()=>{});}}saveData();}

function isSkullReaction(reaction){const name=reaction.emoji?.name;return name==='💀'||String(name||'').toLowerCase()==='skull';}
function getSkulls(gid,uid){const c=getConfig(gid);return Math.max(0,Number(c.skulls[uid]||0));}
function changeSkulls(gid,uid,amount){const c=getConfig(gid),next=Math.max(0,getSkulls(gid,uid)+amount);if(next===0)delete c.skulls[uid];else c.skulls[uid]=next;saveData();return next;}
function skullsEmbed(user,count){return new EmbedBuilder().setColor(0x2b2d31).setDescription(user+' you have **'+count+'** skull'+(count===1?'':'s')+' 💀').setTimestamp();}
function skullboardEmbed(gid){const entries=Object.entries(getConfig(gid).skulls).map(([uid,count])=>({uid,count:Number(count)||0})).filter(x=>x.count>0).sort((a,b)=>b.count-a.count||a.uid.localeCompare(b.uid)).slice(0,10);const lines=entries.length?entries.map((x,n)=>'**'+(n+1)+'.** <@'+x.uid+'> — **'+x.count+'** 💀'):['No skulls have been recorded yet.'];return new EmbedBuilder().setTitle('💀 Skull Leaderboard').setColor(0x2b2d31).setDescription(lines.join('\n')).setFooter({text:'Top 10 skull counts in this server.'}).setTimestamp();}
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
function helpText(prefix){ return `**Moderation commands**\n\`${prefix}help\` • commands\n\`${prefix}nsfw on/off\` • NSFW filter\n\`${prefix}gore on/off\` • gore filter\n\`${prefix}pii on/off\` • redact emails/IPs/addresses\n\`${prefix}prefix <new>\` • change prefix\n\`${prefix}setlogs #channel\` • audit logs\n\`${prefix}config\` • protection settings\n\`${prefix}warn @user [reason]\`\n\`${prefix}warnings @user\`\n\`${prefix}clearwarnings @user\`\n\`${prefix}timeout @user 10m [reason]\`\n\`${prefix}kick @user [reason]\`\n\`${prefix}ban @user [reason]\`\n\`${prefix}lock\` / \`${prefix}unlock\`\n\`${prefix}slowmode 10\`\n\`${prefix}antiinvite on/off\`\n\`${prefix}antispam on/off\``; }
async function executeCommand(message,name,args){
  const cfg=getConfig(message.guild.id), prefix=cfg.prefix||DEFAULT_PREFIX;
  const filterCommands=['prefix','nsfw','gore','pii','setlogs','config','antiinvite','antispam'];
  const moderationCommands=['warn','warnings','clearwarnings','timeout','kick','ban','lock','unlock','slowmode'];
  await commandLog(message,name,args);
  if(filterCommands.includes(name)&&!canManageServer(message.member)) return message.reply({embeds:[commandEmbed('🔒 Permission denied','You need **Manage Server** to use this command.',0xed4245)]});
  if(moderationCommands.includes(name)&&!canBan(message.member)) return message.reply({embeds:[commandEmbed('🔒 Permission denied','You need **Ban Members** to use moderation commands.',0xed4245)]});
  if(name==='help') return message.reply({embeds:[commandEmbed('📖 Commands',helpText(prefix))]});
  if(name==='prefix'){ const next=args[0]; if(!next||next.length>3||/\s/.test(next)||next.startsWith('/')) return message.reply({embeds:[commandEmbed('⚙️ Prefix','Usage: `'+prefix+'prefix <1-3 non-space characters>`',0xed4245)]}); cfg.prefix=next; saveData(); return message.reply({embeds:[commandEmbed('⚙️ Prefix changed','Prefix is now `'+next+'`. Use `'+next+'help` for commands.',0x57f287)]}); }
  if(['nsfw','gore','pii','antiinvite','antispam'].includes(name)){ const value=args[0]?.toLowerCase(); if(!['on','off'].includes(value)) return message.reply({embeds:[commandEmbed('⚙️ Invalid option','Usage: `'+prefix+name+' on/off`',0xed4245)]}); const key=name==='nsfw'?'nsfwFilter':name==='gore'?'goreFilter':name; cfg[key]=value==='on'; saveData(); return message.reply({embeds:[commandEmbed('🛡️ Filter updated',`**${name.toUpperCase()}** is now **${value}**.`,0x57f287)]}); }
  if(name==='setlogs'){ const ch=message.mentions.channels.first(); if(!ch||ch.type!==ChannelType.GuildText)return message.reply({embeds:[commandEmbed('📋 Audit logs','Usage: `'+prefix+'setlogs #channel`',0xed4245)]}); cfg.auditChannelId=ch.id; saveData(); return message.reply({embeds:[commandEmbed('📋 Audit logs enabled',`Commands and moderation events will be logged to ${ch}.`,0x57f287)]}); }
  if(name==='config') return message.reply({embeds:[new EmbedBuilder().setTitle('🛡️ Server protection').setColor(0x5865f2).setTimestamp().addFields({name:'Prefix',value:`\`${prefix}\``,inline:true},{name:'NSFW',value:cfg.nsfwFilter?'🟢 On':'🔴 Off',inline:true},{name:'Gore',value:cfg.goreFilter?'🟢 On':'🔴 Off',inline:true},{name:'PII',value:cfg.piiFilter?'🟢 On':'🔴 Off',inline:true},{name:'Anti-spam/flood',value:cfg.antiSpam?'🟢 On':'🔴 Off',inline:true},{name:'Anti-invite',value:cfg.antiInvite?'🟢 On':'🔴 Off',inline:true})]});
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
 new SlashCommandBuilder().setName('pii').setDescription('Toggle PII redaction').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
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
 new SlashCommandBuilder().setName('skulls').setDescription('Show your skull count').addUserOption(o=>o.setName('user').setDescription('User to check').setRequired(false)),
 new SlashCommandBuilder().setName('skullboard').setDescription('Show the top 10 skulls'),
 new SlashCommandBuilder().setName('addskulls').setDescription('Add skulls to a user').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addUserOption(o=>o.setName('user').setDescription('User receiving skulls').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Amount to add').setMinValue(1).setMaxValue(100000).setRequired(true)),
 new SlashCommandBuilder().setName('removeskulls').setDescription('Remove skulls from a user').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addUserOption(o=>o.setName('user').setDescription('User losing skulls').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Amount to remove').setMinValue(1).setMaxValue(100000).setRequired(true)),
 new SlashCommandBuilder().setName('channelmode').setDescription('Set detection mode for this channel').addStringOption(o=>o.setName('mode').setDescription('Detection mode').setRequired(true).addChoices({name:'normal',value:'normal'},{name:'strict',value:'strict'},{name:'media',value:'media'},{name:'off',value:'off'}))
].map(c=>c.toJSON());

client.once('ready',async()=>{console.log(`Logged in as ${client.user.tag}`); await cleanupExpiredStrikes(); setInterval(()=>cleanupExpiredStrikes().catch(e=>console.error('Strike cleanup failed:',e?.message||e)),60000);try{await client.application.commands.set([]);console.log('Global slash commands cleared');for(const guild of client.guilds.cache.values()){try{const registered=await guild.commands.set(slashCommands);console.log(`Guild slash commands registered in ${guild.id}: ${registered.size}`);}catch(e){console.error(`Guild slash command registration failed in ${guild.id}:`,e?.message||e);}}}catch(e){console.error('Slash command registration failed:',e?.stack||e?.message||e);}});
client.on('messageCreate',async message=>{if(!message.inGuild()||message.author.bot)return;const cfg=getConfig(message.guild.id);try{const prefix=cfg.prefix||DEFAULT_PREFIX;if(message.content.startsWith(prefix)){const parts=message.content.slice(prefix.length).trim().split(/\s+/);const name=parts.shift()?.toLowerCase();if(name)await executeCommand(message,name,parts).catch(e=>console.error('Prefix command failed:',e?.message||e));}}catch(e){console.error('Message handler failed:',e?.message||e);}});
client.on('messageReactionAdd',async(reaction,user)=>{if(user.bot||!isSkullReaction(reaction))return;try{if(reaction.partial)await reaction.fetch();const message=reaction.message;if(!message?.guild||!message.author)return;changeSkulls(message.guild.id,message.author.id,1);}catch(e){console.error('Skull reaction add failed:',e?.message||e);}});
client.on('messageReactionRemove',async(reaction,user)=>{if(user.bot||!isSkullReaction(reaction))return;try{if(reaction.partial)await reaction.fetch();const message=reaction.message;if(!message?.guild||!message.author)return;changeSkulls(message.guild.id,message.author.id,-1);}catch(e){console.error('Skull reaction remove failed:',e?.message||e);}});
client.on('interactionCreate',async i=>{
  if(!i.inGuild())return;
  const cfg=getConfig(i.guild.id);
  const filterCommands=['prefix','nsfw','gore','pii','setlogs','config','antiinvite','antispam'];
  const moderationCommands=['warn','warnings','clearwarnings','timeout','kick','ban','lock','unlock','slowmode'];
  const advancedCommands=['modpanel','modstats','history','why','channelmode'];
  if(advancedCommands.includes(i.commandName))return;
  const handledCommands=new Set(['help','strike','skulls','skullboard','addskulls','removeskulls',...filterCommands,...moderationCommands]);
  const replyError=async e=>{
    console.error('Interaction failed:',e?.stack||e?.message||e);
    if(!i.replied&&!i.deferred)await i.reply({embeds:[commandEmbed('❌ Error','Something went wrong.',0xed4245)],ephemeral:true}).catch(()=>{});
  };
  try{
    if(i.isButton()&&i.customId.startsWith(STRIKE_APPEAL_PREFIX)){
      const userId=i.customId.slice(STRIKE_APPEAL_PREFIX.length);
      if(i.user.id!==userId)return i.reply({content:'❌ Only the member who received this strike can create its appeal thread.',ephemeral:true});
      const state=cleanActiveStrikes(i.guild.id,userId);
      if(!state.active.length)return i.reply({content:'✅ This strike has already expired.',ephemeral:true});
      if(i.message.hasThread&&i.message.thread)return i.reply({content:'An appeal thread already exists: <#'+i.message.thread.id+'>',ephemeral:true});
      const thread=await i.message.startThread({name:'Strike appeal — '+i.user.username,autoArchiveDuration:1440,reason:'Staff strike appeal'});
      await thread.send({content:'<@'+i.user.id+'> Please explain why you believe this strike was given falsely. Staff can review the appeal here.'});
      return i.reply({content:'✅ Appeal thread created: <#'+thread.id+'>',ephemeral:true});
    }
    if(!i.isChatInputCommand())return;
    if(!handledCommands.has(i.commandName))return i.reply({embeds:[commandEmbed('❌ Command unavailable','Unrecognized slash command.',0xed4245)],ephemeral:true}).catch(()=>{});
    await interactionLog(i,i.commandName);

    if(i.commandName==='skulls'){
      const target=i.options.getUser('user')||i.user;
      return i.reply({embeds:[skullsEmbed(target,getSkulls(i.guild.id,target.id))]});
    }

    if(i.commandName==='skullboard')return i.reply({embeds:[skullboardEmbed(i.guild.id)]});

    if(i.commandName==='addskulls'){
      if(!canManageServer(i.member))return i.reply({content:'❌ You need **Manage Server** to use this command.',ephemeral:true});
      const target=i.options.getUser('user',true),amount=i.options.getInteger('amount',true),total=changeSkulls(i.guild.id,target.id,amount);
      return i.reply({content:'✅ Added **'+amount+'** skull'+(amount===1?'':'s')+' to '+target+'. They now have **'+total+'** 💀'});
    }

    if(i.commandName==='removeskulls'){
      if(!canManageServer(i.member))return i.reply({content:'❌ You need **Manage Server** to use this command.',ephemeral:true});
      const target=i.options.getUser('user',true),amount=i.options.getInteger('amount',true),before=getSkulls(i.guild.id,target.id),total=changeSkulls(i.guild.id,target.id,-amount),removed=before-total;
      return i.reply({content:'✅ Removed **'+removed+'** skull'+(removed===1?'':'s')+' from '+target+'. They now have **'+total+'** 💀'});
    }



    if(filterCommands.includes(i.commandName)&&!canManageServer(i.member))
      return i.reply({embeds:[commandEmbed('🔒 Permission denied','You need **Manage Server** to use this command.',0xed4245)],ephemeral:true});

    if(moderationCommands.includes(i.commandName)&&!canBan(i.member))
      return i.reply({embeds:[commandEmbed('🔒 Permission denied','You need **Ban Members** to use moderation commands.',0xed4245)],ephemeral:true});

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

    if(['nsfw','gore','pii','antiinvite','antispam'].includes(i.commandName)){
      const state=i.options.getString('state');
      const key=i.commandName==='nsfw'?'nsfwFilter':i.commandName==='gore'?'goreFilter':i.commandName;
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
          {name:'PII',value:cfg.piiFilter?'🟢 On':'🔴 Off',inline:true},
          {name:'Anti-spam/flood',value:cfg.antiSpam?'🟢 On':'🔴 Off',inline:true},
          {name:'Anti-invite',value:cfg.antiInvite?'🟢 On':'🔴 Off',inline:true}
        )]});

    const user=i.options.getUser('user');
    const target=user?await i.guild.members.fetch(user.id).catch(()=>null):null;

    if(['warn','warnings','clearwarnings','timeout','kick','ban'].includes(i.commandName)&&!target)
      return i.reply({embeds:[commandEmbed('❌ Missing member','That user is not currently in this server.',0xed4245)],ephemeral:true});

    if(i.commandName==='strike'){
      if(!target)return i.reply({embeds:[commandEmbed('❌ Missing member','That user is not currently in this server.',0xed4245)],ephemeral:true});
      const reason=String(i.options.getString('reason')||'No reason provided').replace(/\r?\n/g,' ').replace(/@/g,'@\u200b').slice(0,500);
      const state=cleanActiveStrikes(i.guild.id,target.id);
      const now=new Date();
      state.active.push({id:Date.now()+'-'+i.id,reason,moderatorId:i.user.id,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+STRIKE_DURATION_MS).toISOString()});
      state.record.items=state.active;
      let updated=false;
      if(state.record.messageId&&state.record.channelId){
        const ch=await i.guild.channels.fetch(state.record.channelId).catch(()=>null);
        const msg=ch?.isTextBased()?await ch.messages.fetch(state.record.messageId).catch(()=>null):null;
        if(msg){await msg.edit({embeds:[strikeEmbed(target,state.active)],components:[strikeAppealRow(target.id)]});updated=true;}
        else{state.record.messageId=null;state.record.channelId=null;}
      }
      if(updated)await i.reply({content:'✅ Strike added to '+target+'.',ephemeral:true});
      else{const board=await i.reply({embeds:[strikeEmbed(target,state.active)],components:[strikeAppealRow(target.id)],fetchReply:true});state.record.channelId=i.channelId;state.record.messageId=board.id;}
      saveData();
      return;
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

client.login(process.env.DISCORD_TOKEN).then(()=>console.log('Discord login successful')).catch(e=>{console.error('Discord login failed:',e?.message||e);process.exit(1);});
