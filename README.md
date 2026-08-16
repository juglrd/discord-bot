# Discord Content Moderator

A Discord bot that scans image attachments and automatically removes content detected as:

- NSFW / sexual content
- Sexual content involving minors
- Graphic violence / gore

## Stack

- Node.js 20+
- discord.js
- OpenAI Moderation (`omni-moderation-latest`)

The moderation endpoint supports image inputs and returns category flags/scores. The bot uses the category flags for removal decisions.

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable the **Message Content Intent** for the bot.
3. Invite the bot to your server with permission to **View Channels**, **Read Message History**, and **Manage Messages**.
4. Create an OpenAI API key.
5. Copy `.env.example` to `.env` and fill in both secrets.
6. Install dependencies with `npm install`.
7. Start with `npm start`.

## Important

Never commit `.env` or either API key to GitHub. The `.gitignore` already protects `.env` files.

The first version scans JPEG, PNG and WebP images. Videos are intentionally not scanned yet; video moderation can be added by extracting frames and sending representative frames through the same moderation pipeline.
