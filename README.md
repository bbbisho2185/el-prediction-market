# Slack Prediction Market Bot

A Slack bot that allows anyone to create prediction markets with fake money. Users start with 1,000 coins and can create markets, place bets, and compete on the leaderboard.

## Features

- **Create Markets**: Anyone can create a prediction market with a question and 2-10 options
- **Place Bets**: Bet fake coins on outcomes you believe in
- **Dynamic Odds**: See real-time odds based on the betting pool
- **Leaderboard**: Compete for the top spot
- **Fair Payouts**: Winners share the losing pool proportionally to their bets
- **Cancel Bets**: Change your mind? Cancel your bet while the market is still open
- **Betting History**: Track your performance with detailed stats

## Commands

| Command | Description |
|---------|-------------|
| `/predict help` | Show help message |
| `/predict create` | Create a new prediction market |
| `/predict markets` | List open markets in the channel |
| `/predict <id>` | View details of a specific market |
| `/predict balance` | Check your coin balance |
| `/predict mybets` | View your active bets (with cancel option) |
| `/predict history` | View your betting history & stats |
| `/predict leaderboard` | See the top traders |

## Setup

### 1. Create a Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click "Create New App"
3. Choose **"From a manifest"** (recommended) or "From scratch"

#### Option A: From a Manifest (Recommended)

1. Select your workspace
2. Choose **JSON** tab
3. Paste the contents of `slack-manifest.json` from this repo
4. Click "Create"
5. Skip to step 2 below

#### Option B: From Scratch

1. Name your app (e.g., "Prediction Market") and select your workspace
2. Go to **OAuth & Permissions** and add Bot Token Scopes:
   - `chat:write`, `commands`, `users:read`
3. Go to **Slash Commands** → Create `/predict` command
4. Go to **Interactivity & Shortcuts** → Enable interactivity
5. Continue to step 2 below

### 2. Enable Socket Mode & Get Tokens

1. Go to **Socket Mode** → Enable it
2. Click "Generate" to create an App-Level Token with `connections:write` scope
3. Copy the token (starts with `xapp-`)

### 3. Install App & Get Remaining Tokens

1. Go to **Install App** → Click "Install to Workspace" → Authorize
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
3. Go to **Basic Information** → Copy the **Signing Secret**

### 4. Configure Environment

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Fill in your tokens:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token
```

### 5. Install Dependencies and Run

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the bot
npm start

# Or run in development mode
npm run dev
```

## How It Works

### Creating a Market

1. Use `/predict create` to open the creation modal
2. Enter your question and options (one per line)
3. The market is announced in the channel

### Betting

1. Click "Place a Bet" on any market
2. Select your predicted outcome
3. Enter your bet amount
4. Your bet is announced and the pool updates

### Resolution

Only the market creator can resolve their market:

1. View the market details
2. Click "Resolve"
3. Select the winning option
4. Winners receive their payouts automatically

### Payout Calculation

Winners receive:
- Their original bet back
- A proportional share of the losing pool

Formula: `payout = bet + (bet / winning_pool) * losing_pool`

Example:
- Market has 1000 coins on "Yes" and 500 coins on "No"
- "Yes" wins
- A user who bet 200 on "Yes" gets: `200 + (200/1000) * 500 = 300 coins`

## Development

```bash
# Type check
npm run typecheck

# Build
npm run build

# Run in development
npm run dev
```

## Database

The bot uses SQLite for persistent storage. The database file is created automatically at `prediction_market.db` (configurable via `DATABASE_PATH`).

Tables:
- `users` - User balances and info
- `markets` - Prediction markets
- `bets` - Individual bets

## License

MIT
