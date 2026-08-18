import 'dotenv/config';
import fs from 'node:fs';
import { Client, GatewayIntentBits, PermissionsBitField, SlashCommandBuilder, EmbedBuilder, ChannelType } from 'discord.js';

if (!process.env.DISCORD_TOKEN) { console.error('Missing DISCORD_TOKEN in environment variables.'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
const DATA_FILE = './settings.json';
const DEFAULT_PREFIX = "'";
const DEFAULTS = { prefix: DEFAULT_PREFIX, nsfwFilter: true, goreFilter: true, piiFilter: true, auditChannelId: null, antiInvite: true, antiSpam: true, warnings: {} };

function loadData(){ try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch { return {}; } }
const data = loadData();
function saveData(){ try { fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); } catch(e) { console.error('Could not save settings:', e.message); } }
function getConfig(guildId){ if(!data[guildId]) data[guildId]=structuredClone(DEFAULTS); data[guildId]={...DEFAULTS,...data[guildId],warnings:data[guildId].warnings||{}}; if(typeof data[guildId].prefix!=='string'||!data[guildId].prefix)data[guildId].prefix=DEFAULT_PREFIX; return data[guildId]; }
function isMod(member){ return !!(member?.permissions.has(PermissionsBitField.Flags.ManageGuild)||member?.permissions.has(PermissionsBitField.Flags.ManageMessages)||member?.permissions.has(PermissionsBitField.Flags.Administrator)); }
function prefixFor(guildId){ return getConfig(guildId).prefix || DEFAULT_PREFIX; }
function parseDuration(input){ const m=String(input||'').match(/^(\d+)(s|m|h|d)$/i); return m ? Number(m[1])*({s:1000,m:60000,h:3600000,d:86400000}[m[2].toLowerCase()]) : null; }
function formatDuration(ms){ for(const [u,v] of [['d',86400000],['h',3600000],['m',60000],['s',1000]]) if(ms>=v)return `${Math.round(ms/v)}${u}`; return '0s'; }
function helpText(prefix){ return `**Moderation commands**\n\`${prefix}help\` • commands\n\`${prefix}nsfw on/off\` • NSFW filter\n\`${prefix}gore on/off\` • gore filter\n\`${prefix}pii on/off\` • redact emails/IPs/addresses\n\`${prefix}prefix <new>\` • change prefix\n\`${prefix}setlogs #channel\` • audit logs\n\`${prefix}config\` • protection settings\n\`${prefix}warn @user [reason]\`\n\`${prefix}warnings @user\`\n\`${prefix}clearwarnings @user\`\n\`${prefix}timeout @user 10m [reason]\`\n\`${prefix}kick @user [reason]\`\n\`${prefix}ban @user [reason]\`\n\`${prefix}lock\` / \`${prefix}unlock\`\n\`${prefix}slowmode 10\`\n\`${prefix}antiinvite on/off\`\n\`${prefix}antispam on/off\``; }
async function executeCommand(message,name,args){
  const cfg=getConfig(message.guild.id), prefix=cfg.prefix||DEFAULT_PREFIX;
  const modOnly=['prefix','nsfw','gore','pii','setlogs','config','warn','warnings','clearwarnings','timeout','kick','ban','lock','unlock','slowmode','antiinvite','antispam'];
  if(modOnly.includes(name)&&!isMod(message.member)) return message.reply('❌ You need **Manage Server**, **Manage Messages**, or **Administrator**.');
  if(name==='help') return message.reply(helpText(prefix));
  if(name==='prefix'){ const next=args[0]; if(!next||next.length>3||/\s/.test(next)||next.startsWith('/')) return message.reply(`Usage: \`${prefix}prefix <1-3 non-space characters>\``); cfg.prefix=next; saveData(); return message.reply(`✅ Prefix changed to \`${next}\`. Use \`${next}help\` for commands.`); }
  if(['nsfw','gore','pii','antiinvite','antispam'].includes(name)){ const value=args[0]?.toLowerCase(); if(!['on','off'].includes(value)) return message.reply(`Usage: \`${prefix}${name} on/off\``); const key=name==='nsfw'?'nsfwFilter':name==='gore'?'goreFilter':name; cfg[key]=value==='on'; saveData(); return message.reply(`✅ **${name}** is now **${value}**.`); }
  if(name==='setlogs'){ const ch=message.mentions.channels.first(); if(!ch||ch.type!==ChannelType.GuildText)return message.reply(`Usage: \`${prefix}setlogs #channel\``); cfg.auditChannelId=ch.id; saveData(); return message.reply(`✅ Audit logs will be sent to ${ch}.`); }
  if(name==='config') return message.reply({embeds:[new EmbedBuilder().setTitle('🛡️ Server protection').setColor(0x5865f2).addFields({name:'Prefix',value:`\`${prefix}\``,inline:true},{name:'NSFW',value:cfg.nsfwFilter?'🟢 On':'🔴 Off',inline:true},{name:'Gore',value:cfg.goreFilter?'🟢 On':'🔴 Off',inline:true},{name:'PII',value:cfg.piiFilter?'🟢 On':'🔴 Off',inline:true},{name:'Anti-spam/flood',value:cfg.antiSpam?'🟢 On':'🔴 Off',inline:true},{name:'Anti-invite',value:cfg.antiInvite?'🟢 On':'🔴 Off',inline:true})]});
  const target=message.mentions.members.first();
  if(['warn','warnings','clearwarnings','timeout','kick','ban'].includes(name)&&!target)return message.reply(`❌ Mention a member. Example: \`${prefix}${name} @user\``);
  if(name==='warn'){const reason=args.slice(1).join(' ')||'No reason provided';cfg.warnings[target.id]??=[];cfg.warnings[target.id].push({reason,moderator:message.author.id,at:new Date().toISOString()});saveData();return message.reply(`⚠️ ${target} has been warned. **Reason:** ${reason}`);}
  if(name==='warnings'){const w=cfg.warnings[target.id]||[];return message.reply(w.length?`**Warnings for ${target}:**\n${w.map((x,i)=>`${i+1}. ${x.reason}`).join('\n')}`:`✅ ${target} has no warnings.`);}
  if(name==='clearwarnings'){delete cfg.warnings[target.id];saveData();return message.reply(`✅ Cleared warnings for ${target}.`);}
  if(name==='timeout'){const ms=parseDuration(args[1]);if(!ms)return message.reply(`Usage: \`${prefix}timeout @user 10m [reason]\``);await target.timeout(Math.min(ms,28*86400000),args.slice(2).join(' ')||'No reason provided');return message.reply(`✅ Timed out ${target} for ${formatDuration(ms)}.`);}
  if(name==='kick'){await target.kick(args.slice(1).join(' ')||'No reason provided');return message.reply(`✅ Kicked ${target.user.tag}.`);}
  if(name==='ban'){await target.ban({reason:args.slice(1).join(' ')||'No reason provided'});return message.reply(`✅ Banned ${target.user.tag}.`);}
  if(name==='lock'||name==='unlock'){const locked=name==='lock';await message.channel.permissionOverwrites.edit(message.guild.roles.everyone,{SendMessages:!locked});return message.reply(`✅ ${locked?'Locked':'Unlocked'} ${message.channel}.`);}
  if(name==='slowmode'){const seconds=Number(args[0]);if(!Number.isInteger(seconds)||seconds<0||seconds>21600)return message.reply('Enter slowmode seconds from 0 to 21600.');await message.channel.setRateLimitPerUser(seconds);return message.reply(`✅ Slowmode set to **${seconds}s**.`);}
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
 new SlashCommandBuilder().setName('antispam').setDescription('Toggle anti-spam').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'}))
].map(c=>c.toJSON());

client.once('ready',async()=>{console.log(`Logged in as ${client.user.tag}`);try{await client.application.commands.set(slashCommands);console.log('Slash commands registered.');}catch(e){console.error('Slash command registration failed:',e.message);}});
client.on('messageCreate',async message=>{if(!message.inGuild()||message.author.bot)return;const cfg=getConfig(message.guild.id);try{const prefix=cfg.prefix||DEFAULT_PREFIX;if(message.content.startsWith(prefix)){const parts=message.content.slice(prefix.length).trim().split(/\s+/);const name=parts.shift()?.toLowerCase();if(name)await executeCommand(message,name,parts).catch(e=>console.error('Prefix command failed:',e?.message||e));}}catch(e){console.error('Message handler failed:',e?.message||e);}});
client.on('interactionCreate',async i=>{if(!i.isChatInputCommand()||!i.inGuild())return;const cfg=getConfig(i.guild.id);try{if(i.commandName==='prefix'){if(!isMod(i.member))return i.reply({content:'❌ Moderator permission required.',ephemeral:true});const p=i.options.getString('value');if(!p||p.length>3||/\s/.test(p)||p.startsWith('/'))return i.reply({content:'❌ Prefix must be 1-3 non-space characters and cannot start with /.',ephemeral:true});cfg.prefix=p;saveData();return i.reply(`✅ Prefix changed to \`${p}\`.`);}if(i.commandName==='help')return i.reply(helpText(cfg.prefix||DEFAULT_PREFIX));if(['nsfw','gore','pii','antiinvite','antispam'].includes(i.commandName)){if(!isMod(i.member))return i.reply({content:'❌ Moderator permission required.',ephemeral:true});const state=i.options.getString('state');const key=i.commandName==='nsfw'?'nsfwFilter':i.commandName==='gore'?'goreFilter':i.commandName;cfg[key]=state==='on';saveData();return i.reply(`✅ **${i.commandName}** is now **${state}**.`);}if(i.commandName==='config')return i.reply({embeds:[new EmbedBuilder().setTitle('🛡️ Server protection').setColor(0x5865f2).addFields({name:'Prefix',value:`\`${cfg.prefix}\``,inline:true},{name:'NSFW',value:cfg.nsfwFilter?'🟢 On':'🔴 Off',inline:true},{name:'Gore',value:cfg.goreFilter?'🟢 On':'🔴 Off',inline:true},{name:'PII',value:cfg.piiFilter?'🟢 On':'🔴 Off',inline:true},{name:'Anti-spam/flood',value:cfg.antiSpam?'🟢 On':'🔴 Off',inline:true},{name:'Anti-invite',value:cfg.antiInvite?'🟢 On':'🔴 Off',inline:true})]});}catch(e){console.error('Interaction failed:',e?.message||e);if(!i.replied&&!i.deferred)await i.reply({content:'❌ Something went wrong.',ephemeral:true}).catch(()=>{});}});

client.login(process.env.DISCORD_TOKEN).then(()=>console.log('Discord login successful')).catch(e=>{console.error('Discord login failed:',e?.message||e);process.exit(1);});
