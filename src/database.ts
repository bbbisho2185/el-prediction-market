import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'prediction_market.db');

let db: SqlJsDatabase;

// Save database to file
function saveDatabase(): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Initialize database
export async function initializeDatabase(): Promise<void> {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 1000,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      winning_option INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      channel_id TEXT NOT NULL,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      payout INTEGER,
      FOREIGN KEY (market_id) REFERENCES markets(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Create indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_markets_channel ON markets(channel_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id)');

  saveDatabase();
}

// Helper to convert sql.js result to array of objects
function queryAll<T>(sql: string, params: any[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);

  const results: T[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push(row as T);
  }
  stmt.free();
  return results;
}

function queryOne<T>(sql: string, params: any[] = []): T | undefined {
  const results = queryAll<T>(sql, params);
  return results[0];
}

function runSql(sql: string, params: any[] = []): void {
  db.run(sql, params);
  saveDatabase();
}

function getLastInsertRowId(): number {
  const result = queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
  return result?.id ?? 0;
}

// User operations
export interface User {
  id: string;
  username: string;
  balance: number;
  created_at: string;
}

export function getOrCreateUser(userId: string, username: string): User {
  const existing = queryOne<User>('SELECT * FROM users WHERE id = ?', [userId]);

  if (existing) {
    if (existing.username !== username && username) {
      runSql('UPDATE users SET username = ? WHERE id = ?', [username, userId]);
      existing.username = username;
    }
    return existing;
  }

  runSql('INSERT INTO users (id, username) VALUES (?, ?)', [userId, username]);
  return queryOne<User>('SELECT * FROM users WHERE id = ?', [userId])!;
}

export function getUserBalance(userId: string): number {
  const user = queryOne<{ balance: number }>('SELECT balance FROM users WHERE id = ?', [userId]);
  return user?.balance ?? 0;
}

export function updateUserBalance(userId: string, newBalance: number): void {
  runSql('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
}

export function getLeaderboard(limit: number = 10): User[] {
  return queryAll<User>('SELECT * FROM users ORDER BY balance DESC LIMIT ?', [limit]);
}

// Market operations
export interface Market {
  id: number;
  creator_id: string;
  question: string;
  options: string;
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
  runSql(
    'INSERT INTO markets (creator_id, question, options, channel_id) VALUES (?, ?, ?, ?)',
    [creatorId, question, JSON.stringify(options), channelId]
  );

  const lastId = getLastInsertRowId();
  return queryOne<Market>('SELECT * FROM markets WHERE id = ?', [lastId])!;
}

export function getMarket(marketId: number): Market | undefined {
  return queryOne<Market>('SELECT * FROM markets WHERE id = ?', [marketId]);
}

export function getMarketWithDetails(marketId: number): MarketWithDetails | undefined {
  const market = getMarket(marketId);
  if (!market) return undefined;

  const parsedOptions = JSON.parse(market.options) as string[];
  const bets = queryAll<{ option_index: number; total: number }>(
    'SELECT option_index, SUM(amount) as total FROM bets WHERE market_id = ? GROUP BY option_index',
    [marketId]
  );

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
    return queryAll<Market>(
      'SELECT * FROM markets WHERE status = ? AND channel_id = ? ORDER BY created_at DESC',
      ['open', channelId]
    );
  }
  return queryAll<Market>('SELECT * FROM markets WHERE status = ? ORDER BY created_at DESC', ['open']);
}

export function closeMarket(marketId: number): void {
  runSql('UPDATE markets SET status = ? WHERE id = ?', ['closed', marketId]);
}

export function resolveMarket(marketId: number, winningOption: number): void {
  const market = getMarketWithDetails(marketId);
  if (!market) throw new Error('Market not found');

  const winningPool = market.optionTotals[winningOption];
  const losingPool = market.totalPool - winningPool;

  if (winningPool > 0) {
    const bets = queryAll<Bet>(
      'SELECT * FROM bets WHERE market_id = ? AND option_index = ?',
      [marketId, winningOption]
    );

    for (const bet of bets) {
      const payout = bet.amount + Math.floor((bet.amount / winningPool) * losingPool);

      runSql('UPDATE bets SET payout = ? WHERE id = ?', [payout, bet.id]);

      const user = queryOne<{ balance: number }>('SELECT balance FROM users WHERE id = ?', [bet.user_id]);
      if (user) {
        runSql('UPDATE users SET balance = ? WHERE id = ?', [user.balance + payout, bet.user_id]);
      }
    }
  }

  runSql('UPDATE bets SET payout = 0 WHERE market_id = ? AND option_index != ?', [marketId, winningOption]);
  runSql("UPDATE markets SET status = 'resolved', winning_option = ?, resolved_at = datetime('now') WHERE id = ?", [winningOption, marketId]);
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
  runSql(
    'INSERT INTO bets (market_id, user_id, option_index, amount) VALUES (?, ?, ?, ?)',
    [marketId, userId, optionIndex, amount]
  );

  const lastId = getLastInsertRowId();

  const user = queryOne<{ balance: number }>('SELECT balance FROM users WHERE id = ?', [userId]);
  if (user) {
    runSql('UPDATE users SET balance = ? WHERE id = ?', [user.balance - amount, userId]);
  }

  return queryOne<Bet>('SELECT * FROM bets WHERE id = ?', [lastId])!;
}

export function getUserBetsForMarket(userId: string, marketId: number): Bet[] {
  return queryAll<Bet>('SELECT * FROM bets WHERE user_id = ? AND market_id = ?', [userId, marketId]);
}

export function getBetsForMarket(marketId: number): Bet[] {
  return queryAll<Bet>('SELECT * FROM bets WHERE market_id = ?', [marketId]);
}

export function getUserActiveBets(userId: string): Array<Bet & { question: string }> {
  return queryAll<Bet & { question: string }>(`
    SELECT b.*, m.question
    FROM bets b
    JOIN markets m ON b.market_id = m.id
    WHERE b.user_id = ? AND m.status != 'resolved'
    ORDER BY b.created_at DESC
  `, [userId]);
}

export function getDatabase(): SqlJsDatabase {
  return db;
}
