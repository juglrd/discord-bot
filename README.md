# Discord Content Moderator

A Discord moderation bot focused on reducing harmful content and helping server staff keep their community under control.

## Protection features

- NSFW/sexual-content filter (toggleable)
- Graphic violence/gore filter (toggleable)
- Text and supported image moderation
- Discord invite blocking
- Anti-spam protection
- Configurable audit-log channel
- Join/leave audit logs
- Persistent per-server settings
- Warning system
- Timeouts, kicks and bans
- Channel lock/unlock
- Slowmode controls
- `config` command to inspect protection settings

## Commands

The bot supports both **prefix commands using `'`** and Discord slash commands.

Examples:

- `'nsfw on` / `/nsfw state:on`
- `'gore off` / `/gore state:off`
- `'setlogs #mod-logs` / `/setlogs channel:#mod-logs`
- `'config` / `/config`
- `'warn @user reason` / `/warn`
- `'warnings @user` / `/warnings`
- `'clearwarnings @user` / `/clearwarnings`
- `'timeout @user 10m reason` / `/timeout`
- `'kick @user reason` / `/kick`
- `'ban @user reason` / `/ban`
- `'lock` / `/lock`
- `'unlock` / `/unlock`
- `'slowmode 10` / `/slowmode seconds:10`
- `'antiinvite on` / `/antiinvite`
- `'antispam on` / `/antispam`
- `'help` / `/help`

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable **Message Content Intent** and **Server Members Intent** for the bot.
3. Invite the bot with the permissions it needs, including View Channels, Read Message History, Manage Messages, Moderate Members, Kick Members, Ban Members and Manage Channels.
4. Create an OpenAI API key.
5. Copy `.env.example` to `.env` and fill in both secrets.
6. Install dependencies with `npm install`.
7. Start with `npm start`.

## Important

Never commit `.env` or either API key to GitHub. The `.gitignore` protects `.env` files.

The bot is intended to help with server moderation and does **not** bypass Discord enforcement or Discord's Terms of Service. Staff should still review their server rules, permissions and content.

The moderation endpoint supports image inputs. Videos are not scanned yet because the current implementation does not extract video frames.
