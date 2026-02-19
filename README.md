# Jules Slack Mention Bot

A Cloudflare Worker that lets Slack users create [Jules](https://jules.google.com) tasks by @mentioning the bot.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jdoconnor/jules-slack-mention)

## Features

- **@mention to create tasks**: Mention the bot in any channel with your task description
- **Direct messages**: DM the bot to create tasks privately
- **Per-user API tokens**: Each Slack user sets their own Jules API key
- **Auto PR creation**: Jules automatically creates pull requests for completed tasks
- **Status updates**: Bot notifies when tasks complete with PR links

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Choose "From a manifest" and use this:

```yaml
display_information:
  name: Jules Bot
  description: Create Jules tasks from Slack
features:
  bot_user:
    display_name: Jules
    always_online: true
  slash_commands:
    - command: /jules-token
      url: https://jules-slack-mention.YOUR_SUBDOMAIN.workers.dev/slack/events
      description: Set your Jules API token
      should_escape: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - commands
      - im:history
      - im:write
      - reactions:write
settings:
  event_subscriptions:
    request_url: https://jules-slack-mention.YOUR_SUBDOMAIN.workers.dev/slack/events
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: false
```

3. Install the app to your workspace and note the **Bot User OAuth Token** (starts with `xoxb-`)
4. Get your **Signing Secret** from Basic Information

### 2. Deploy to Cloudflare

Click the deploy button above or:

```bash
# Clone and install
git clone https://github.com/jdoconnor/jules-slack-mention
cd jules-slack-mention
npm install

# Create KV namespace
npx wrangler kv:namespace create USER_TOKENS
# Update wrangler.toml with the returned namespace ID

# Set secrets
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN

# Set bot user ID (find by mentioning your bot in Slack)
npx wrangler secret put SLACK_BOT_USER_ID

# Deploy
npm run deploy
```

### 3. Configure Slack

1. Go to your Slack app's **Event Subscriptions**
2. Enable events and set the Request URL to your worker URL: `https://jules-slack-mention.YOUR_SUBDOMAIN.workers.dev/slack/events`
3. Subscribe to bot events: `app_mention`, `message.im`
4. Go to **Slash Commands** and create `/jules-token` with the same request URL
5. Reinstall the app if prompted

## Usage

1. **Register your Jules API token**:
   ```
   /jules-token your-api-key-here
   ```
   Get your API key from [jules.google.com/settings](https://jules.google.com/settings)

2. **Create a task by @mentioning**:
   ```
   @Jules Fix the login bug in the authentication module
   ```

3. **Or DM the bot directly** with your task

4. The bot will:
   - React with 🚀 to acknowledge
   - Create a Jules session
   - Notify you when the PR is ready

## Architecture

- **Cloudflare Workers**: Edge runtime for fast responses
- **KV Namespace**: Stores user API tokens securely
- **Slack Events API**: Receives mentions and DMs
- **Jules REST API**: Creates and monitors coding sessions

## Local Development

```bash
npm run dev
```

Use [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-tunnels/) to expose your local server:

```bash
cloudflared tunnel --url http://localhost:8787
```

Update your Slack app's Request URL with the tunnel URL for testing.

## Configuration

| Variable | Description |
|----------|-------------|
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token |
| `SLACK_BOT_USER_ID` | Bot's user ID (for mention parsing) |
