import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'prediction_market.db');

const db = new Database(DB_PATH);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize database schema
export function initializeDatabase(): void {
  db.exec(`
    -- Users table to track balances
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 1000,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Markets table for prediction markets
    CREATE TABLE IF NOT EXISTS markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,  -- JSON array of option strings
      status TEXT NOT NULL DEFAULT 'open',  -- open, closed, resolved
      winning_option INTEGER,  -- Index of the winning option (null until resolved)
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      channel_id TEXT NOT NULL,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    );

    -- Bets table for tracking user bets
    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      payout INTEGER,  -- Filled in when market is resolved
      FOREIGN KEY (market_id) REFERENCES markets(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Create indexes for faster lookups
    CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
    CREATE INDEX IF NOT EXISTS idx_markets_channel ON markets(channel_id);
    CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
    CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
  `);
}

// User operations
export interface User {
  id: string;
  username: string;
  balance: number;
  created_at: string;
}

export function getOrCreateUser(userId: string, username: string): User {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;

  if (existing) {
    // Update username if changed
    if (existing.username !== username) {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, userId);
      existing.username = username;
    }
    return existing;
  }

  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(userId, username);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
}

export function getUserBalance(userId: string): number {
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as { balance: number } | undefined;
  return user?.balance ?? 0;
}

export function updateUserBalance(userId: string, newBalance: number): void {
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, userId);
}

export function getLeaderboard(limit: number = 10): User[] {
  return db.prepare('SELECT * FROM users ORDER BY balance DESC LIMIT ?').all(limit) as User[];
}

// Market operations
export interface Market {
  id: number;
  creator_id: string;
  question: string;
  options: string;  // JSON string
  status: 'open' | 'closed' | 'resolved';
  winning_option: number | null;
  created_at: string;
  resolved_at: string | null;
  channel_id: string;
}

export interface MarketWithDetails extends Market {
  parsedOptions: string[];
  totalPool: number;
  optionTotals: number[];
}

export function createMarket(creatorId: string, question: string, options: string[], channelId: string): Market {
  const result = db.prepare(
    'INSERT INTO markets (creator_id, question, options, channel_id) VALUES (?, ?, ?, ?)'
  ).run(creatorId, question, JSON.stringify(options), channelId);

  return db.prepare('SELECT * FROM markets WHERE id = ?').get(result.lastInsertRowid) as Market;
}

export function getMarket(marketId: number): Market | undefined {
  return db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId) as Market | undefined;
}

export function getMarketWithDetails(marketId: number): MarketWithDetails | undefined {
  const market = getMarket(marketId);
  if (!market) return undefined;

  const parsedOptions = JSON.parse(market.options) as string[];
  const bets = db.prepare('SELECT option_index, SUM(amount) as total FROM bets WHERE market_id = ? GROUP BY option_index').all(marketId) as { option_index: number; total: number }[];

  const optionTotals = parsedOptions.map(() => 0);
  let totalPool = 0;

  for (const bet of bets) {
    optionTotals[bet.option_index] = bet.total;
    totalPool += bet.total;
  }

  return {
    ...market,
    parsedOptions,
    totalPool,
    optionTotals
  };
}

export function getOpenMarkets(channelId?: string): Market[] {
  if (channelId) {
    return db.prepare('SELECT * FROM markets WHERE status = ? AND channel_id = ? ORDER BY created_at DESC').all('open', channelId) as Market[];
  }
  return db.prepare('SELECT * FROM markets WHERE status = ? ORDER BY created_at DESC').all('open') as Market[];
}

export function closeMarket(marketId: number): void {
  db.prepare('UPDATE markets SET status = ? WHERE id = ?').run('closed', marketId);
}

export function resolveMarket(marketId: number, winningOption: number): void {
  const market = getMarketWithDetails(marketId);
  if (!market) throw new Error('Market not found');

  const winningPool = market.optionTotals[winningOption];
  const losingPool = market.totalPool - winningPool;

  // Calculate payouts for winners
  if (winningPool > 0) {
    const bets = db.prepare('SELECT * FROM bets WHERE market_id = ? AND option_index = ?').all(marketId, winningOption) as Bet[];

    for (const bet of bets) {
      // Winners get their bet back plus proportional share of losing pool
      const payout = bet.amount + Math.floor((bet.amount / winningPool) * losingPool);

      db.prepare('UPDATE bets SET payout = ? WHERE id = ?').run(payout, bet.id);

      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(bet.user_id) as { balance: number };
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(user.balance + payout, bet.user_id);
    }
  }

  // Mark losing bets with 0 payout
  db.prepare('UPDATE bets SET payout = 0 WHERE market_id = ? AND option_index != ?').run(marketId, winningOption);

  // Update market status
  db.prepare("UPDATE markets SET status = 'resolved', winning_option = ?, resolved_at = datetime('now') WHERE id = ?").run(winningOption, marketId);
}

// Bet operations
export interface Bet {
  id: number;
  market_id: number;
  user_id: string;
  option_index: number;
  amount: number;
  created_at: string;
  payout: number | null;
}

export function placeBet(marketId: number, userId: string, optionIndex: number, amount: number): Bet {
  const result = db.prepare(
    'INSERT INTO bets (market_id, user_id, option_index, amount) VALUES (?, ?, ?, ?)'
  ).run(marketId, userId, optionIndex, amount);

  // Deduct from user balance
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as { balance: number };
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(user.balance - amount, userId);

  return db.prepare('SELECT * FROM bets WHERE id = ?').get(result.lastInsertRowid) as Bet;
}

export function getUserBetsForMarket(userId: string, marketId: number): Bet[] {
  return db.prepare('SELECT * FROM bets WHERE user_id = ? AND market_id = ?').all(userId, marketId) as Bet[];
}

export function getBetsForMarket(marketId: number): Bet[] {
  return db.prepare('SELECT * FROM bets WHERE market_id = ?').all(marketId) as Bet[];
}

export function getUserActiveBets(userId: string): Array<Bet & { question: string }> {
  return db.prepare(`
    SELECT b.*, m.question
    FROM bets b
    JOIN markets m ON b.market_id = m.id
    WHERE b.user_id = ? AND m.status != 'resolved'
    ORDER BY b.created_at DESC
  `).all(userId) as Array<Bet & { question: string }>;
}

export default db;
