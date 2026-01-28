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
      expires_at TEXT,
      featured INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )
  `);

  // Add columns if they don't exist (for existing databases)
  try { db.run('ALTER TABLE markets ADD COLUMN expires_at TEXT'); } catch (e) { /* column already exists */ }
  try { db.run('ALTER TABLE markets ADD COLUMN featured INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* column already exists */ }

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

function getLastInsertRowId(table: string): number {
  const result = db.exec(`SELECT MAX(id) as id FROM ${table}`);
  if (result.length > 0 && result[0].values.length > 0) {
    return result[0].values[0][0] as number;
  }
  return 0;
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
  expires_at: string | null;
  featured: number;
}

export interface MarketWithDetails extends Market {
  parsedOptions: string[];
  totalPool: number;
  optionTotals: number[];
}

export function createMarket(creatorId: string, question: string, options: string[], channelId: string, expiresAt?: string): Market {
  console.log('Creating market:', { creatorId, question, options: options.length, channelId, expiresAt });

  if (expiresAt) {
    runSql(
      'INSERT INTO markets (creator_id, question, options, channel_id, expires_at) VALUES (?, ?, ?, ?, ?)',
      [creatorId, question, JSON.stringify(options), channelId, expiresAt]
    );
  } else {
    runSql(
      'INSERT INTO markets (creator_id, question, options, channel_id) VALUES (?, ?, ?, ?)',
      [creatorId, question, JSON.stringify(options), channelId]
    );
  }

  const lastId = getLastInsertRowId('markets');
  console.log('Last insert ID:', lastId);

  const market = queryOne<Market>('SELECT * FROM markets WHERE id = ?', [lastId]);
  console.log('Created market:', market);

  if (!market) {
    throw new Error(`Failed to retrieve created market with ID ${lastId}`);
  }

  return market;
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

  const lastId = getLastInsertRowId('bets');

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

export interface BetHistoryItem {
  id: number;
  market_id: number;
  question: string;
  option_index: number;
  options: string;
  amount: number;
  payout: number | null;
  market_status: string;
  winning_option: number | null;
  created_at: string;
  resolved_at: string | null;
}

export function getUserBetHistory(userId: string, limit: number = 20): BetHistoryItem[] {
  return queryAll<BetHistoryItem>(`
    SELECT
      b.id,
      b.market_id,
      m.question,
      b.option_index,
      m.options,
      b.amount,
      b.payout,
      m.status as market_status,
      m.winning_option,
      b.created_at,
      m.resolved_at
    FROM bets b
    JOIN markets m ON b.market_id = m.id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
    LIMIT ?
  `, [userId, limit]);
}

export function getBet(betId: number): Bet | undefined {
  return queryOne<Bet>('SELECT * FROM bets WHERE id = ?', [betId]);
}

export function cancelBet(betId: number): void {
  const bet = getBet(betId);
  if (!bet) throw new Error('Bet not found');

  // Refund the user
  const user = queryOne<{ balance: number }>('SELECT balance FROM users WHERE id = ?', [bet.user_id]);
  if (user) {
    runSql('UPDATE users SET balance = ? WHERE id = ?', [user.balance + bet.amount, bet.user_id]);
  }

  // Delete the bet
  runSql('DELETE FROM bets WHERE id = ?', [betId]);
}

export function closeExpiredMarkets(): Market[] {
  const expired = queryAll<Market>(
    "SELECT * FROM markets WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= datetime('now')"
  );
  if (expired.length > 0) {
    runSql("UPDATE markets SET status = 'closed' WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= datetime('now')");
  }
  return expired;
}

export function setMarketFeatured(marketId: number, featured: boolean): void {
  runSql('UPDATE markets SET featured = ? WHERE id = ?', [featured ? 1 : 0, marketId]);
}

export function getFeaturedMarkets(channelId?: string): Market[] {
  if (channelId) {
    return queryAll<Market>(
      "SELECT * FROM markets WHERE featured = 1 AND status = 'open' AND channel_id = ? ORDER BY created_at DESC",
      [channelId]
    );
  }
  return queryAll<Market>(
    "SELECT * FROM markets WHERE featured = 1 AND status = 'open' ORDER BY created_at DESC"
  );
}

export function searchMarkets(keyword: string, channelId?: string): Market[] {
  const pattern = `%${keyword}%`;
  if (channelId) {
    return queryAll<Market>(
      'SELECT * FROM markets WHERE question LIKE ? AND channel_id = ? ORDER BY created_at DESC LIMIT 20',
      [pattern, channelId]
    );
  }
  return queryAll<Market>(
    'SELECT * FROM markets WHERE question LIKE ? ORDER BY created_at DESC LIMIT 20',
    [pattern]
  );
}

export function getDatabase(): SqlJsDatabase {
  return db;
}
