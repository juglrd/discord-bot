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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PREFIX = "'";
const DATA_FILE = './settings.json';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const spamBuckets = new Map();
const duplicateSpamBuckets = new Map();
const DUPLICATE_WINDOW_MS = 10000;
const DUPLICATE_THRESHOLD = 3;

const DEFAULTS = {
  nsfwFilter: true,
  goreFilter: true,
  auditChannelId: null,
  antiInvite: true,
  antiSpam: true,
  warnings: {}
};

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}
function saveData() { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
function getConfig(guildId) {
  if (!data[guildId]) data[guildId] = structuredClone(DEFAULTS);
  data[guildId] = { ...DEFAULTS, ...data[guildId], warnings: data[guildId].warnings || {} };
  return data[guildId];
}
const data = loadData();

function isMod(member) {
  return member?.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    member?.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
    member?.permissions.has(PermissionsBitField.Flags.Administrator);
}

async function logAction(guild, title, description, color = 0x5865f2) {
  const cfg = getConfig(guild.id);
  if (!cfg.auditChannelId) return;
  const channel = guild.channels.cache.get(cfg.auditChannelId);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function moderateImage(url) {
  const response = await openai.moderations.create({
    model: 'omni-moderation-latest',
    input: [{ type: 'image_url', image_url: { url } }]
  });
  return response.results[0];
}

async function moderateText(text) {
  const response = await openai.moderations.create({ model: 'omni-moderation-latest', input: text });
  return response.results[0];
}

function reasonsFor(result, cfg) {
  const c = result?.categories ?? {};
  const reasons = [];
  if (cfg.nsfwFilter && (c.sexual || c['sexual/minors'])) reasons.push('NSFW/sexual content');
  if (cfg.goreFilter && c['violence/graphic']) reasons.push('graphic violence/gore');
  return reasons;
}

async function removeIfUnsafe(message) {
  const cfg = getConfig(message.guild.id);
  if (!cfg.nsfwFilter && !cfg.goreFilter) return false;

  try {
    const textResult = message.content?.trim() ? await moderateText(message.content) : null;
    const textReasons = textResult ? reasonsFor(textResult, cfg) : [];
    if (textReasons.length) {
      await message.delete().catch(() => {});
      await logAction(message.guild, '🛡️ Content removed', `${message.author} in <#${message.channel.id}>\n**Reason:** ${textReasons.join(' + ')}`, 0xed4245);
      return true;
    }

    for (const attachment of message.attachments.values()) {
      if (!attachment.contentType || !IMAGE_TYPES.has(attachment.contentType)) continue;
      const result = await moderateImage(attachment.url);
      const reasons = reasonsFor(result, cfg);
      if (!reasons.length) continue;
      await message.delete().catch(() => {});
      await logAction(message.guild, '🛡️ Image removed', `${message.author} in <#${message.channel.id}>\n**Reason:** ${reasons.join(' + ')}`, 0xed4245);
      return true;
    }
  } catch (error) {
    console.error('Moderation request failed:', error?.message || error);
  }
  return false;
}

async function executeCommand(message, name, args) {
  const cfg = getConfig(message.guild.id);
  const member = message.member;
  const modOnly = ['nsfw', 'gore', 'setlogs', 'config', 'warn', 'warnings', 'clearwarnings', 'timeout', 'kick', 'ban', 'unban', 'lock', 'unlock', 'slowmode', 'antiinvite', 'antispam'];
  if (modOnly.includes(name) && !isMod(member)) return message.reply('❌ You need **Manage Server**, **Manage Messages**, or **Administrator** to use this command.');

  if (name === 'help') return message.reply(`**Moderation commands**\n\`${PREFIX}nsfw on/off\` • toggle NSFW filter\n\`${PREFIX}gore on/off\` • toggle gore filter\n\`${PREFIX}setlogs #channel\` • choose audit-log channel\n\`${PREFIX}config\` • view protection settings\n\`${PREFIX}warn @user [reason]\` • warn a member\n\`${PREFIX}warnings @user\` • view warnings\n\`${PREFIX}clearwarnings @user\` • clear warnings\n\`${PREFIX}timeout @user 10m [reason]\` • timeout\n\`${PREFIX}kick @user [reason]\` • kick\n\`${PREFIX}ban @user [reason]\` • ban\n\`${PREFIX}lock\` / \`${PREFIX}unlock\` • lock current channel\n\`${PREFIX}slowmode 10\` • set slowmode seconds\n\`${PREFIX}antiinvite on/off\` • block Discord invites\n\`${PREFIX}antispam on/off\` • anti-spam protection`);

  if (['nsfw', 'gore', 'antiinvite', 'antispam'].includes(name)) {
    const value = args[0]?.toLowerCase();
    if (!['on', 'off'].includes(value)) return message.reply(`Usage: \`${PREFIX}${name} on/off\``);
    const key = name === 'nsfw' ? 'nsfwFilter' : name === 'gore' ? 'goreFilter' : name;
    cfg[key] = value === 'on'; saveData();
    await logAction(message.guild, '⚙️ Protection setting changed', `${message.author} set **${name}** to **${value}**.`);
    return message.reply(`✅ **${name}** filter is now **${value}**.`);
  }

  if (name === 'setlogs') {
    const channel = message.mentions.channels.first();
    if (!channel || channel.type !== ChannelType.GuildText) return message.reply(`Usage: \`${PREFIX}setlogs #channel\``);
    cfg.auditChannelId = channel.id; saveData();
    return message.reply(`✅ Audit logs will now be sent to ${channel}.`);
  }

  if (name === 'config') {
    return message.reply({ embeds: [new EmbedBuilder().setTitle('🛡️ Server protection').setColor(0x5865f2)
      .addFields(
        { name: 'NSFW filter', value: cfg.nsfwFilter ? '🟢 On' : '🔴 Off', inline: true },
        { name: 'Gore filter', value: cfg.goreFilter ? '🟢 On' : '🔴 Off', inline: true },
        { name: 'Anti-invite', value: cfg.antiInvite ? '🟢 On' : '🔴 Off', inline: true },
        { name: 'Anti-spam', value: cfg.antiSpam ? '🟢 On' : '🔴 Off', inline: true },
        { name: 'Audit logs', value: cfg.auditChannelId ? `<#${cfg.auditChannelId}>` : 'Not configured', inline: true }
      )] });
  }

  const target = message.mentions.members.first();
  if (['warn', 'warnings', 'clearwarnings', 'timeout', 'kick', 'ban'].includes(name) && !target) return message.reply(`❌ Mention a member. Example: \`${PREFIX}${name} @user\``);
  if (name === 'warn') {
    const reason = args.slice(1).join(' ') || 'No reason provided';
    cfg.warnings[target.id] ??= [];
    cfg.warnings[target.id].push({ reason, moderator: message.author.id, at: new Date().toISOString() }); saveData();
    await logAction(message.guild, '⚠️ Member warned', `${target} was warned by ${message.author}.\n**Reason:** ${reason}`, 0xfee75c);
    return message.reply(`⚠️ ${target} has been warned. **Reason:** ${reason}`);
  }
  if (name === 'warnings') {
    const warnings = cfg.warnings[target.id] || [];
    return message.reply(warnings.length ? `**Warnings for ${target}:**\n${warnings.map((w, i) => `${i + 1}. ${w.reason}`).join('\n')}` : `✅ ${target} has no warnings.`);
  }
  if (name === 'clearwarnings') { delete cfg.warnings[target.id]; saveData(); return message.reply(`✅ Cleared warnings for ${target}.`); }
  if (name === 'timeout') {
    const ms = parseDuration(args[1]); if (!ms) return message.reply(`Usage: \`${PREFIX}timeout @user 10m [reason]\``);
    const reason = args.slice(2).join(' ') || 'No reason provided'; await target.timeout(Math.min(ms, 28 * 24 * 60 * 60 * 1000), reason);
    await logAction(message.guild, '⏱️ Member timed out', `${target} by ${message.author}.\n**Reason:** ${reason}`); return message.reply(`✅ Timed out ${target} for ${formatDuration(ms)}.`);
  }
  if (name === 'kick') { const reason = args.slice(1).join(' ') || 'No reason provided'; await target.kick(reason); await logAction(message.guild, '👢 Member kicked', `${target.user.tag} by ${message.author}.\n**Reason:** ${reason}`); return message.reply(`✅ Kicked ${target.user.tag}.`); }
  if (name === 'ban') { const reason = args.slice(1).join(' ') || 'No reason provided'; await target.ban({ reason }); await logAction(message.guild, '🔨 Member banned', `${target.user.tag} by ${message.author}.\n**Reason:** ${reason}`); return message.reply(`✅ Banned ${target.user.tag}.`); }
  if (name === 'lock' || name === 'unlock') {
    const locked = name === 'lock'; await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: !locked });
    await logAction(message.guild, locked ? '🔒 Channel locked' : '🔓 Channel unlocked', `${message.author} changed ${message.channel} state.`); return message.reply(`✅ ${locked ? 'Locked' : 'Unlocked'} ${message.channel}.`);
  }
  if (name === 'slowmode') { const seconds = Number(args[0]); if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) return message.reply('Enter slowmode seconds from 0 to 21600.'); await message.channel.setRateLimitPerUser(seconds); return message.reply(`✅ Slowmode set to **${seconds}s**.`); }
}

function parseDuration(input) {
  const m = String(input || '').match(/^(\d+)(s|m|h|d)$/i); if (!m) return null;
  const n = Number(m[1]); return n * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()]);
}
function formatDuration(ms) { const units = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]]; for (const [u, v] of units) if (ms >= v) return `${Math.round(ms / v)}${u}`; return '0s'; }

const slashCommands = [
  new SlashCommandBuilder().setName('help').setDescription('Show moderation commands'),
  new SlashCommandBuilder().setName('nsfw').setDescription('Turn the NSFW filter on/off').addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
  new SlashCommandBuilder().setName('gore').setDescription('Turn the gore filter on/off').addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
  new SlashCommandBuilder().setName('setlogs').setDescription('Set the audit log channel').addChannelOption(o => o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('config').setDescription('View server protection settings'),
  new SlashCommandBuilder().setName('warn').setDescription('Warn a member').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('warnings').setDescription('View member warnings').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
  new SlashCommandBuilder().setName('clearwarnings').setDescription('Clear member warnings').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
  new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('duration').setDescription('e.g. 10m').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('lock').setDescription('Lock the current channel'),
  new SlashCommandBuilder().setName('unlock').setDescription('Unlock the current channel'),
  new SlashCommandBuilder().setName('slowmode').setDescription('Set channel slowmode').addIntegerOption(o=>o.setName('seconds').setDescription('0-21600').setMinValue(0).setMaxValue(21600).setRequired(true)),
  new SlashCommandBuilder().setName('antiinvite').setDescription('Toggle Discord invite blocking').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
  new SlashCommandBuilder().setName('antispam').setDescription('Toggle anti-spam protection').addStringOption(o=>o.setName('state').setDescription('on/off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'}))
].map(c => c.toJSON());

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await client.application.commands.set(slashCommands).catch(err => console.error('Slash command registration failed:', err.message));
  console.log('Slash commands registered.');
});

client.on('messageCreate', async (message) => {
  if (!message.inGuild() || message.author.bot) return;
  const cfg = getConfig(message.guild.id);

  if (cfg.antiInvite && /(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i.test(message.content) && !isMod(message.member)) {
    await message.delete().catch(() => {});
    await logAction(message.guild, '🔗 Discord invite blocked', `${message.author} posted an invite in ${message.channel}.`, 0xed4245);
    return;
  }

  if (cfg.antiSpam && !isMod(message.member)) {
    const now = Date.now();

    // Rapid-message spam detection.
    const rapidKey = `${message.guild.id}:${message.author.id}`;
    const bucket = spamBuckets.get(rapidKey) || [];
    bucket.push(now);
    while (bucket.length && bucket[0] < now - 6000) bucket.shift();
    spamBuckets.set(rapidKey, bucket);

    if (bucket.length >= 7) {
      await message.member.timeout(10 * 60 * 1000, 'Automatic anti-spam protection').catch(() => {});
      spamBuckets.delete(rapidKey);
      await logAction(message.guild, '🚨 Anti-spam triggered', `${message.author} was automatically timed out for rapid messaging.`, 0xed4245);
      return;
    }

    // Duplicate spam detection: same text, same attachment(s), or the same
    // text + attachment combination repeated several times in a short window.
    const attachmentKey = [...message.attachments.values()]
      .map(a => a.url.split('?')[0])
      .sort()
      .join('|');
    const normalizedContent = message.content.trim().replace(/\s+/g, ' ');
    const duplicateKey = `${normalizedContent}::${attachmentKey}`;
    const bucketKey = `${message.guild.id}:${message.channel.id}:${message.author.id}:${duplicateKey}`;

    let duplicates = duplicateSpamBuckets.get(bucketKey) || [];
    duplicates = duplicates.filter(entry => entry.createdAt >= now - DUPLICATE_WINDOW_MS);
    duplicates.push({ id: message.id, createdAt: now });
    duplicateSpamBuckets.set(bucketKey, duplicates);

    if (duplicates.length >= DUPLICATE_THRESHOLD) {
      const fetched = await message.channel.messages.fetch({ limit: 100 }).catch(() => null);
      const ids = new Set(duplicates.map(entry => entry.id));

      if (fetched) {
        for (const msg of fetched.values()) {
          if (msg.author.id !== message.author.id) continue;
          const msgAttachmentKey = [...msg.attachments.values()]
            .map(a => a.url.split('?')[0])
            .sort()
            .join('|');
          const msgContent = msg.content.trim().replace(/\s+/g, ' ');
          if (`${msgContent}::${msgAttachmentKey}` === duplicateKey) ids.add(msg.id);
        }
      }

      let deleted = 0;
      for (const id of ids) {
        if (id === message.id) {
          if (await message.delete().then(() => true).catch(() => false)) deleted++;
        } else {
          const msg = fetched?.get(id);
          if (msg && await msg.delete().then(() => true).catch(() => false)) deleted++;
        }
      }

      duplicateSpamBuckets.delete(bucketKey);
      await logAction(
        message.guild,
        '🧹 Duplicate spam removed',
        `${message.author} spammed the same message/attachment in <#${message.channel.id}>.\n**Deleted:** ${deleted} message(s).`,
        0xed4245
      );
      return;
    }
  }

  if (message.content.startsWith(PREFIX)) {
    const parts = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const name = parts.shift()?.toLowerCase();
    if (name) await executeCommand(message, name, parts).catch(err => { console.error(err); message.reply('❌ That action failed. Check my permissions.').catch(() => {}); });
    return;
  }

  await removeIfUnsafe(message);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const name = interaction.commandName;
  const member = interaction.member;
  const modOnly = ['nsfw','gore','setlogs','config','warn','warnings','clearwarnings','timeout','kick','ban','lock','unlock','slowmode','antiinvite','antispam'];
  if (modOnly.includes(name) && !isMod(member)) return interaction.reply({ content: '❌ You need Manage Server, Manage Messages, or Administrator.', ephemeral: true });

  const cfg = getConfig(interaction.guild.id);
  const state = interaction.options.getString('state');
  if (['nsfw','gore','antiinvite','antispam'].includes(name)) {
    const key = name === 'nsfw' ? 'nsfwFilter' : name === 'gore' ? 'goreFilter' : name;
    cfg[key] = state === 'on'; saveData();
    await logAction(interaction.guild, '⚙️ Protection setting changed', `${interaction.user} set **${name}** to **${state}**.`);
    return interaction.reply(`✅ **${name}** is now **${state}**.`);
  }
  if (name === 'help') return interaction.reply('Use `/config` to view protection settings. Moderation commands include `/warn`, `/warnings`, `/clearwarnings`, `/timeout`, `/kick`, `/ban`, `/lock`, `/unlock`, `/slowmode`, `/setlogs`, `/nsfw`, `/gore`, `/antiinvite`, and `/antispam`.');
  if (name === 'setlogs') { const ch = interaction.options.getChannel('channel'); cfg.auditChannelId = ch.id; saveData(); return interaction.reply(`✅ Audit logs will be sent to ${ch}.`); }
  if (name === 'config') return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🛡️ Server protection').setColor(0x5865f2).addFields(
    {name:'NSFW',value:cfg.nsfwFilter?'🟢 On':'🔴 Off',inline:true},{name:'Gore',value:cfg.goreFilter?'🟢 On':'🔴 Off',inline:true},{name:'Anti-invite',value:cfg.antiInvite?'🟢 On':'🔴 Off',inline:true},{name:'Anti-spam',value:cfg.antiSpam?'🟢 On':'🔴 Off',inline:true},{name:'Audit logs',value:cfg.auditChannelId?`<#${cfg.auditChannelId}>`:'Not configured',inline:true}
  )] });

  const target = interaction.options.getMember('user');
  if (['warn','warnings','clearwarnings','timeout','kick','ban'].includes(name) && !target) return interaction.reply({content:'❌ I could not find that member.',ephemeral:true});
  if (name === 'warn') { const reason=interaction.options.getString('reason')||'No reason provided'; cfg.warnings[target.id]??=[]; cfg.warnings[target.id].push({reason,moderator:interaction.user.id,at:new Date().toISOString()}); saveData(); await logAction(interaction.guild,'⚠️ Member warned',`${target} was warned by ${interaction.user}.\n**Reason:** ${reason}`,0xfee75c); return interaction.reply(`⚠️ ${target} has been warned. **Reason:** ${reason}`); }
  if (name === 'warnings') { const w=cfg.warnings[target.id]||[]; return interaction.reply(w.length?`**Warnings for ${target}:**\n${w.map((x,i)=>`${i+1}. ${x.reason}`).join('\n')}`:`✅ ${target} has no warnings.`); }
  if (name === 'clearwarnings') { delete cfg.warnings[target.id]; saveData(); return interaction.reply(`✅ Cleared warnings for ${target}.`); }
  if (name === 'timeout') { const ms=parseDuration(interaction.options.getString('duration')); if(!ms)return interaction.reply({content:'❌ Use formats like 10m, 2h, or 1d.',ephemeral:true}); const reason=interaction.options.getString('reason')||'No reason provided'; await target.timeout(Math.min(ms,28*86400000),reason); await logAction(interaction.guild,'⏱️ Member timed out',`${target} by ${interaction.user}.\n**Reason:** ${reason}`); return interaction.reply(`✅ Timed out ${target} for ${formatDuration(ms)}.`); }
  if (name === 'kick') { const reason=interaction.options.getString('reason')||'No reason provided'; await target.kick(reason); await logAction(interaction.guild,'👢 Member kicked',`${target.user.tag} by ${interaction.user}.\n**Reason:** ${reason}`); return interaction.reply(`✅ Kicked ${target.user.tag}.`); }
  if (name === 'ban') { const reason=interaction.options.getString('reason')||'No reason provided'; await target.ban({reason}); await logAction(interaction.guild,'🔨 Member banned',`${target.user.tag} by ${interaction.user}.\n**Reason:** ${reason}`); return interaction.reply(`✅ Banned ${target.user.tag}.`); }
  if (name === 'lock' || name === 'unlock') { const locked=name==='lock'; await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone,{SendMessages:!locked}); await logAction(interaction.guild,locked?'🔒 Channel locked':'🔓 Channel unlocked',`${interaction.user} changed ${interaction.channel} state.`); return interaction.reply(`✅ ${locked?'Locked':'Unlocked'} ${interaction.channel}.`); }
  if (name === 'slowmode') { const seconds=interaction.options.getInteger('seconds'); await interaction.channel.setRateLimitPerUser(seconds); return interaction.reply(`✅ Slowmode set to **${seconds}s**.`); }
});

client.on('guildMemberAdd', async member => { await logAction(member.guild,'📥 Member joined',`${member.user.tag} joined the server.`); });
client.on('guildMemberRemove', async member => { await logAction(member.guild,'📤 Member left',`${member.user.tag} left the server.`); });

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
client.login(process.env.DISCORD_TOKEN);
