import 'dotenv/config';
import fs from 'node:fs';
import { Client, GatewayIntentBits, PermissionsBitField, SlashCommandBuilder, EmbedBuilder, ChannelType } from 'discord.js';
import OpenAI from 'openai';

const required = ['DISCORD_TOKEN', 'OPENAI_API_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in environment variables.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
const PREFIX = "'";
const DATA_FILE = './settings.json';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const DEFAULTS = { nsfwFilter: true, goreFilter: true, piiFilter: true, auditChannelId: null, antiInvite: true, antiSpam: true, warnings: {} };
const spamBuckets = new Map();
const duplicateBuckets = new Map();
const moderationCache = new Map();
const moderationQueue = [];
let activeModerations = 0;
const MODERATION_CONCURRENCY = 1;
const DUPLICATE_WINDOW_MS = 12000;
const DUPLICATE_THRESHOLD = 3;
const RAPID_WINDOW_MS = 6000;
const RAPID_THRESHOLD = 7;
const MAX_LOG_CONTENT = 500;

function loadData() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; } }
const data = loadData();
function saveData() { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
function getConfig(guildId) {
  if (!data[guildId]) data[guildId] = structuredClone(DEFAULTS);
  data[guildId] = { ...DEFAULTS, ...data[guildId], warnings: data[guildId].warnings || {} };
  return data[guildId];
}
function isMod(member) {
  return !!member && (member.permissions.has(PermissionsBitField.Flags.ManageGuild) || member.permissions.has(PermissionsBitField.Flags.ManageMessages) || member.permissions.has(PermissionsBitField.Flags.Administrator));
}
async function logAction(guild, title, description, color = 0x5865f2) {
  const cfg = getConfig(guild.id);
  if (!cfg.auditChannelId) return;
  const channel = guild.channels.cache.get(cfg.auditChannelId);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(description.slice(0, 3900)).setColor(color).setTimestamp()] }).catch(() => {});
}

// Deliberately NO phone-number regex: Discord IDs, pings, timestamps and normal numbers are not phone numbers.
function redactPII(text) {
  let out = text;
  out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]');
  out = out.replace(/\b(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP redacted]');
  // High-confidence street address only; ordinary number strings are untouched.
  out = out.replace(/\b\d{1,6}\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,4}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|boulevard|blvd|parkway|pkwy)\b/gi, '[address redacted]');
  return out;
}
function normalizeForDetection(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!]/g, 'i')
    .replace(/0/g, 'o').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
function attachmentFingerprint(message) {
  return [...message.attachments.values()]
    .map(a => `${a.url.split('?')[0]}|${a.size || 0}|${a.contentType || ''}`)
    .sort().join('||');
}
function messageFingerprint(message) {
  return `${normalizeForDetection(message.content || '')}::${attachmentFingerprint(message)}`;
}
function safePreview(text) { return redactPII(text || '').slice(0, MAX_LOG_CONTENT); }

function cacheGet(key) {
  const item = moderationCache.get(key);
  if (!item || Date.now() - item.at > 30000) { moderationCache.delete(key); return null; }
  return item.result;
}
function cacheSet(key, result) { moderationCache.set(key, { result, at: Date.now() }); }

async function withRateLimitRetry(fn) {
  let delay = 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fn(); }
    catch (error) {
      const status = error?.status || error?.statusCode;
      if (status !== 429 || attempt === 3) throw error;
      const retryAfter = Number(error?.headers?.get?.('retry-after') || error?.headers?.get?.('x-ratelimit-reset-after') || delay / 1000);
      const wait = Math.min(Math.max(retryAfter * 1000, delay), 15000);
      console.warn(`OpenAI rate limited; retrying in ${Math.ceil(wait / 1000)}s.`);
      await new Promise(resolve => setTimeout(resolve, wait));
      delay *= 2;
    }
  }
}
async function moderateText(text) {
  const key = `t:${normalizeForDetection(text)}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const response = await withRateLimitRetry(() => openai.moderations.create({ model: 'omni-moderation-latest', input: text }));
  const result = response.results?.[0] || {};
  cacheSet(key, result);
  return result;
}
async function moderateImage(url) {
  const key = `i:${url.split('?')[0]}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const response = await withRateLimitRetry(() => openai.moderations.create({ model: 'omni-moderation-latest', input: [{ type: 'image_url', image_url: { url } }] }));
  const result = response.results?.[0] || {};
  cacheSet(key, result);
  return result;
}
function reasonsFor(result, cfg) {
  const categories = result?.categories || {};
  const reasons = [];
  if (cfg.nsfwFilter && (categories.sexual || categories['sexual/minors'])) reasons.push('NSFW/sexual content');
  if (cfg.goreFilter && categories['violence/graphic']) reasons.push('graphic violence/gore');
  return reasons;
}

function enqueueModeration(task) {
  moderationQueue.push(task);
  processModerationQueue();
}
async function processModerationQueue() {
  while (activeModerations < MODERATION_CONCURRENCY && moderationQueue.length) {
    const task = moderationQueue.shift();
    activeModerations++;
    Promise.resolve().then(task)
      .catch(error => console.error('Moderation task failed:', error?.message || error))
      .finally(() => { activeModerations--; processModerationQueue(); });
  }
}

async function redactMessagePII(message, cfg) {
  if (!cfg.piiFilter || !message.content?.trim() || isMod(message.member)) return false;
  const redacted = redactPII(message.content);
  if (redacted === message.content) return false;
  const edited = await message.edit(redacted.slice(0, 2000)).then(() => true).catch(() => false);
  if (!edited) return false;
  await logAction(message.guild, '🔒 Personal information redacted', `${message.author} • **Channel:** <#${message.channel.id}>\n**Message ID:** \`${message.id}\`\n**Message:** ${safePreview(redacted)}`);
  return true;
}

async function removeIfUnsafe(message) {
  const cfg = getConfig(message.guild.id);
  if (isMod(message.member)) return;
  try {
    const text = message.content?.trim();
    if (text && (cfg.nsfwFilter || cfg.goreFilter)) {
      const result = await moderateText(text);
      let reasons = reasonsFor(result, cfg);
      if (!reasons.length) {
        const normalized = normalizeForDetection(text);
        const originalNormalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalized.length > 2 && normalized !== originalNormalized) {
          reasons = reasonsFor(await moderateText(normalized), cfg);
        }
      }
      if (reasons.length) {
        const deleted = await message.delete().then(() => true).catch(() => false);
        if (deleted) await logAction(message.guild, '🛡️ Content removed', `${message.author} • **Channel:** <#${message.channel.id}>\n**Message ID:** \`${message.id}\`\n**Reason:** ${reasons.join(' + ')}\n**Message:** ${safePreview(text)}`, 0xed4245);
        return;
      }
    }
    for (const attachment of message.attachments.values()) {
      if (!attachment.contentType || !IMAGE_TYPES.has(attachment.contentType) || (!cfg.nsfwFilter && !cfg.goreFilter)) continue;
      const reasons = reasonsFor(await moderateImage(attachment.url), cfg);
      if (!reasons.length) continue;
      const deleted = await message.delete().then(() => true).catch(() => false);
      if (deleted) await logAction(message.guild, '🛡️ Image removed', `${message.author} • **Channel:** <#${message.channel.id}>\n**Message ID:** \`${message.id}\`\n**Attachment:** \`${attachment.name || 'image'}\`\n**Reason:** ${reasons.join(' + ')}`, 0xed4245);
      return;
    }
  } catch (error) { console.error('Moderation request failed:', error?.message || error); }
}

async function handleSpam(message, cfg) {
  if (!cfg.antiSpam || isMod(message.member)) return false;
  const now = Date.now();
  const rapidKey = `${message.guild.id}:${message.channel.id}:${message.author.id}`;
  let rapid = spamBuckets.get(rapidKey) || [];
  rapid = rapid.filter(t => now - t < RAPID_WINDOW_MS);
  rapid.push(now);
  spamBuckets.set(rapidKey, rapid);

  if (rapid.length >= RAPID_THRESHOLD) {
    const timedOut = await message.member.timeout(10 * 60 * 1000, 'Automatic anti-spam protection').then(() => true).catch(() => false);
    await message.delete().catch(() => {});
    spamBuckets.delete(rapidKey);
    await logAction(message.guild, '🚨 Rapid spam detected', `${message.author} • **Channel:** <#${message.channel.id}>\n**Messages:** ${rapid.length} in ${RAPID_WINDOW_MS / 1000}s\n**Latest message ID:** \`${message.id}\`\n**Latest message:** ${safePreview(message.content)}` + (timedOut ? '\n**Action:** 10-minute timeout.' : '\n**Action:** Could not timeout; check bot permissions.'), 0xed4245);
    return true;
  }

  const key = `${rapidKey}:${messageFingerprint(message)}`;
  let duplicates = duplicateBuckets.get(key) || [];
  duplicates = duplicates.filter(item => now - item.at < DUPLICATE_WINDOW_MS);
  duplicates.push({ id: message.id, at: now });
  duplicateBuckets.set(key, duplicates);
  if (duplicates.length < DUPLICATE_THRESHOLD) return false;

  const ids = new Set(duplicates.map(x => x.id));
  const fetched = await message.channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (fetched) {
    const fp = messageFingerprint(message);
    for (const candidate of fetched.values()) {
      if (candidate.author.id === message.author.id && messageFingerprint(candidate) === fp) ids.add(candidate.id);
    }
  }
  let deleted = 0;
  for (const id of ids) {
    const target = id === message.id ? message : fetched?.get(id);
    if (target && await target.delete().then(() => true).catch(() => false)) deleted++;
  }
  duplicateBuckets.delete(key);
  await logAction(message.guild, '🧹 Duplicate spam removed', `${message.author} • **Channel:** <#${message.channel.id}>\n**Messages deleted:** ${deleted}\n**Repeated message:** ${safePreview(message.content) || '(attachment only)'}\n**Latest message ID:** \`${message.id}\``, 0xed4245);
  return true;
}

async function executeCommand(message, name, args) {
  const cfg = getConfig(message.guild.id);
  const modOnly = ['nsfw','gore','pii','setlogs','config','warn','warnings','clearwarnings','timeout','kick','ban','lock','unlock','slowmode','antiinvite','antispam'];
  if (modOnly.includes(name) && !isMod(message.member)) return message.reply('❌ You need **Manage Server**, **Manage Messages**, or **Administrator**.');
  if (name === 'help') return message.reply(`**Moderation commands**\n\`${PREFIX}nsfw on/off\` • NSFW filter\n\`${PREFIX}gore on/off\` • gore filter\n\`${PREFIX}pii on/off\` • redact high-confidence emails/IPs/addresses\n\`${PREFIX}setlogs #channel\` • audit logs\n\`${PREFIX}config\` • protection settings\n\`${PREFIX}warn @user [reason]\`\n\`${PREFIX}warnings @user\`\n\`${PREFIX}clearwarnings @user\`\n\`${PREFIX}timeout @user 10m [reason]\`\n\`${PREFIX}kick @user [reason]\`\n\`${PREFIX}ban @user [reason]\`\n\`${PREFIX}lock\` / \`${PREFIX}unlock\`\n\`${PREFIX}slowmode 10\`\n\`${PREFIX}antiinvite on/off\`\n\`${PREFIX}antispam on/off\``);
  if (['nsfw','gore','pii','antiinvite','antispam'].includes(name)) {
    const value = args[0]?.toLowerCase();
    if (!['on','off'].includes(value)) return message.reply(`Usage: \`${PREFIX}${name} on/off\``);
    const key = name === 'nsfw' ? 'nsfwFilter' : name === 'gore' ? 'goreFilter' : name === 'pii' ? 'piiFilter' : name;
    cfg[key] = value === 'on'; saveData();
    return message.reply(`✅ **${name}** is now **${value}**.`);
  }
  if (name === 'setlogs') {
    const ch = message.mentions.channels.first();
    if (!ch || ch.type !== ChannelType.GuildText) return message.reply(`Usage: \`${PREFIX}setlogs #channel\``);
    cfg.auditChannelId = ch.id; saveData(); return message.reply(`✅ Audit logs will be sent to ${ch}.`);
  }
  if (name === 'config') return message.reply({ embeds: [new EmbedBuilder().setTitle('🛡️ Server protection').setColor(0x5865f2).addFields(
    {name:'NSFW',value:cfg.nsfwFilter?'🟢 On':'🔴 Off',inline:true}, {name:'Gore',value:cfg.goreFilter?'🟢 On':'🔴 Off',inline:true},
    {name:'PII redaction',value:cfg.piiFilter?'🟢 On':'🔴 Off',inline:true}, {name:'Anti-spam',value:cfg.antiSpam?'🟢 On':'🔴 Off',inline:true},
    {name:'Anti-invite',value:cfg.antiInvite?'🟢 On':'🔴 Off',inline:true}, {name:'Logs',value:cfg.auditChannelId?`<#${cfg.auditChannelId}>`:'Not set',inline:true}
  )]});
  const target = message.mentions.members.first();
  if (['warn','warnings','clearwarnings','timeout','kick','ban'].includes(name) && !target) return message.reply(`❌ Mention a member. Example: \`${PREFIX}${name} @user\``);
  if (name === 'warn') { const reason=args.slice(1).join(' ')||'No reason provided'; cfg.warnings[target.id]??=[]; cfg.warnings[target.id].push({reason,moderator:message.author.id,at:new Date().toISOString()}); saveData(); return message.reply(`⚠️ ${target} has been warned. **Reason:** ${reason}`); }
  if (name === 'warnings') { const w=cfg.warnings[target.id]||[]; return message.reply(w.length?`**Warnings for ${target}:**\n${w.map((x,i)=>`${i+1}. ${x.reason}`).join('\n')}`:`✅ ${target} has no warnings.`); }
  if (name === 'clearwarnings') { delete cfg.warnings[target.id]; saveData(); return message.reply(`✅ Cleared warnings for ${target}.`); }
  if (name === 'timeout') { const ms=parseDuration(args[1]); if(!ms)return message.reply(`Usage: \`${PREFIX}timeout @user 10m [reason]\``); const reason=args.slice(2).join(' ')||'No reason provided'; await target.timeout(Math.min(ms,28*86400000),reason); return message.reply(`✅ Timed out ${target} for ${formatDuration(ms)}.`); }
  if (name === 'kick') { const reason=args.slice(1).join(' ')||'No reason provided'; await target.kick(reason); return message.reply(`✅ Kicked ${target.user.tag}.`); }
  if (name === 'ban') { const reason=args.slice(1).join(' ')||'No reason provided'; await target.ban({reason}); return message.reply(`✅ Banned ${target.user.tag}.`); }
  if (name === 'lock' || name === 'unlock') { const locked=name==='lock'; await message.channel.permissionOverwrites.edit(message.guild.roles.everyone,{SendMessages:!locked}); return message.reply(`✅ ${locked?'Locked':'Unlocked'} ${message.channel}.`); }
  if (name === 'slowmode') { const seconds=Number(args[0]); if(!Number.isInteger(seconds)||seconds<0||seconds>21600)return message.reply('Enter slowmode seconds from 0 to 21600.'); await message.channel.setRateLimitPerUser(seconds); return message.reply(`✅ Slowmode set to **${seconds}s**.`); }
}
function parseDuration(input){const m=String(input||'').match(/^(\d+)(s|m|h|d)$/i);if(!m)return null;return Number(m[1])*({s:1000,m:60000,h:3600000,d:86400000}[m[2].toLowerCase()]);}
function formatDuration(ms){for(const [u,v] of [['d',86400000],['h',3600000],['m',60000],['s',1000]])if(ms>=v)return `${Math.round(ms/v)}${u}`;return '0s';}

const slashCommands = [
  new SlashCommandBuilder().setName('help').setDescription('Show moderation commands'),
  new SlashCommandBuilder().setName('nsfw').setDescription('Toggle NSFW filter').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
  new SlashCommandBuilder().setName('gore').setDescription('Toggle gore filter').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
  new SlashCommandBuilder().setName('pii').setDescription('Toggle PII redaction').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
  new SlashCommandBuilder().setName('setlogs').setDescription('Set audit log channel').addChannelOption(o=>o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('config').setDescription('View protection settings'),
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

async function executeSlash(interaction) {
  const name = interaction.commandName;
  const args = [];
  for (const option of interaction.options.data) {
    if (option.type === 6) args.push(`<@${option.value}>`); else args.push(String(option.value));
  }
  // Keep slash actions simple and reliable by mapping them to the same command engine.
  if (name === 'setlogs') {
    const channel = interaction.options.getChannel('channel');
    return interaction.reply({ content: `✅ Audit logs will be sent to ${channel}.`, ephemeral: true }).then(()=>{ const cfg=getConfig(interaction.guildId); cfg.auditChannelId=channel.id; saveData(); });
  }
  if (name === 'config') {
    const cfg=getConfig(interaction.guildId); return interaction.reply({embeds:[new EmbedBuilder().setTitle('🛡️ Server protection').setColor(0x5865f2).addFields({name:'NSFW',value:cfg.nsfwFilter?'🟢 On':'🔴 Off',inline:true},{name:'Gore',value:cfg.goreFilter?'🟢 On':'🔴 Off',inline:true},{name:'PII',value:cfg.piiFilter?'🟢 On':'🔴 Off',inline:true},{name:'Anti-spam',value:cfg.antiSpam?'🟢 On':'🔴 Off',inline:true},{name:'Anti-invite',value:cfg.antiInvite?'🟢 On':'🔴 Off',inline:true})]});
  }
  if (['nsfw','gore','pii','antiinvite','antispam'].includes(name)) {
    const member=interaction.member;
    if(!isMod(member)) return interaction.reply({content:'❌ You need Manage Server, Manage Messages, or Administrator.',ephemeral:true});
    const value=interaction.options.getString('state'); const cfg=getConfig(interaction.guildId); const key=name==='nsfw'?'nsfwFilter':name==='gore'?'goreFilter':name==='pii'?'piiFilter':name; cfg[key]=value==='on'; saveData(); return interaction.reply(`✅ **${name}** is now **${value}**.`);
  }
  if (name === 'help') return interaction.reply('Use `' + PREFIX + 'help` for the full command list.');
  const cfg=getConfig(interaction.guildId); if(!isMod(interaction.member)) return interaction.reply({content:'❌ You need Manage Server, Manage Messages, or Administrator.',ephemeral:true});
  const fake = { guild: interaction.guild, member: interaction.member, author: interaction.user, channel: interaction.channel, mentions: { members: { first: () => { const id=interaction.options.getUser('user')?.id; return id ? interaction.guild.members.cache.get(id) : null; } }, channels: { first: () => interaction.options.getChannel('channel') } }, reply: (payload)=>interaction.reply(payload) };
  if (name==='slowmode') args.splice(0,args.length,String(interaction.options.getInteger('seconds')));
  if (name==='timeout') args.splice(0,args.length,`<@${interaction.options.getUser('user').id}>`,interaction.options.getString('duration'),interaction.options.getString('reason')||'');
  if (['warn','warnings','clearwarnings','kick','ban'].includes(name)) args.splice(0,args.length,`<@${interaction.options.getUser('user').id}>`,interaction.options.getString('reason')||'');
  return executeCommand(fake,name,args);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { await client.application.commands.set(slashCommands); console.log('Slash commands registered.'); }
  catch (error) { console.error('Slash command registration failed:', error?.message || error); }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try { await executeSlash(interaction); }
  catch (error) { console.error('Slash command failed:', error?.message || error); if (!interaction.replied && !interaction.deferred) await interaction.reply({content:'❌ Command failed. Check the bot logs.',ephemeral:true}).catch(()=>{}); }
});

client.on('messageCreate', async message => {
  if (!message.inGuild() || message.author.bot) return;
  const cfg=getConfig(message.guild.id);
  if (isMod(message.member)) return message.content.startsWith(PREFIX) ? executeCommand(message,message.content.slice(1).trim().split(/\s+/).shift()?.toLowerCase(),message.content.slice(1).trim().split(/\s+/).slice(1)).catch(e=>console.error('Prefix command failed:',e?.message||e)) : undefined;

  if (cfg.antiInvite && /(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i.test(message.content)) {
    await message.delete().catch(()=>{});
    await logAction(message.guild,'🔗 Discord invite blocked',`${message.author} • **Channel:** <#${message.channel.id}>\n**Message ID:** \`${message.id}\`\n**Message:** ${safePreview(message.content)}`,0xed4245);
    return;
  }
  if (await handleSpam(message,cfg)) return;

  // PII runs independently of NSFW/gore, fixing the previous early-return bug.
  if (await redactMessagePII(message,cfg)) return;

  if (message.content.startsWith(PREFIX)) {
    const parts=message.content.slice(PREFIX.length).trim().split(/\s+/);
    const name=parts.shift()?.toLowerCase();
    if(name) { await executeCommand(message,name,parts).catch(e=>console.error('Prefix command failed:',e?.message||e)); return; }
  }
  if (message.attachments.size || message.content?.trim()) enqueueModeration(()=>removeIfUnsafe(message));
});

setInterval(() => {
  const now=Date.now();
  for (const [key,items] of spamBuckets) { const live=items.filter(t=>now-t<RAPID_WINDOW_MS); if(live.length) spamBuckets.set(key,live); else spamBuckets.delete(key); }
  for (const [key,items] of duplicateBuckets) { const live=items.filter(x=>now-x.at<DUPLICATE_WINDOW_MS); if(live.length) duplicateBuckets.set(key,live); else duplicateBuckets.delete(key); }
  for (const [key,item] of moderationCache) if(now-item.at>30000) moderationCache.delete(key);
}, 30000).unref();

client.login(process.env.DISCORD_TOKEN).then(()=>console.log('Discord login successful')).catch(error=>{console.error('Discord login failed:',error?.message||error);process.exit(1);});
