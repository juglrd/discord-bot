import 'dotenv/config';
import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';
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
    GatewayIntentBits.MessageContent
  ]
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp'
]);

async function moderateImage(url) {
  const response = await openai.moderations.create({
    model: 'omni-moderation-latest',
    input: [
      {
        type: 'image_url',
        image_url: { url }
      }
    ]
  });

  return response.results[0];
}

function shouldRemove(result) {
  const categories = result?.categories ?? {};

  // Remove explicit sexual content and graphic violence/gore.
  return Boolean(
    categories.sexual ||
    categories['sexual/minors'] ||
    categories['violence/graphic']
  );
}

function getReason(result) {
  const categories = result?.categories ?? {};
  const reasons = [];

  if (categories.sexual || categories['sexual/minors']) reasons.push('NSFW/sexual content');
  if (categories['violence/graphic']) reasons.push('graphic violence/gore');

  return reasons.join(' + ') || 'unsafe content';
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (!message.inGuild() || message.author.bot) return;
  if (!message.attachments.size) return;

  // The bot needs Manage Messages to delete offending messages.
  if (!message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    console.error(`Missing Manage Messages permission in guild ${message.guild.name}`);
    return;
  }

  for (const attachment of message.attachments.values()) {
    // We currently scan still images. Videos are left untouched until frame
    // extraction is added, because the moderation endpoint accepts image input.
    if (!attachment.contentType || !IMAGE_TYPES.has(attachment.contentType)) continue;

    try {
      const result = await moderateImage(attachment.url);

      if (!shouldRemove(result)) continue;

      await message.delete().catch((error) => {
        console.error('Could not delete offending message:', error.message);
      });

      console.log(
        `[REMOVED] ${message.author.tag} in #${message.channel.name}: ${getReason(result)}`
      );
      break;
    } catch (error) {
      console.error('Moderation request failed:', error?.message || error);
    }
  }
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

client.login(process.env.DISCORD_TOKEN);
