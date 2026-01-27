import * as db from './database';

const STARTING_BALANCE = 1000;
const MIN_BET = 1;
const MAX_BET = 10000;

export interface CreateMarketResult {
  success: boolean;
  market?: db.Market;
  error?: string;
}

export interface PlaceBetResult {
  success: boolean;
  bet?: db.Bet;
  newBalance?: number;
  error?: string;
}

export interface ResolveMarketResult {
  success: boolean;
  winners?: Array<{ userId: string; username: string; payout: number }>;
  error?: string;
}

export function ensureUser(userId: string, username: string): db.User {
  return db.getOrCreateUser(userId, username);
}

export function createMarket(
  creatorId: string,
  creatorUsername: string,
  question: string,
  options: string[],
  channelId: string
): CreateMarketResult {
  // Ensure creator exists
  ensureUser(creatorId, creatorUsername);

  // Validate inputs
  if (!question || question.trim().length === 0) {
    return { success: false, error: 'Question cannot be empty' };
  }

  if (options.length < 2) {
    return { success: false, error: 'Must have at least 2 options' };
  }

  if (options.length > 10) {
    return { success: false, error: 'Cannot have more than 10 options' };
  }

  // Check for duplicate options
  const uniqueOptions = new Set(options.map(o => o.toLowerCase().trim()));
  if (uniqueOptions.size !== options.length) {
    return { success: false, error: 'All options must be unique' };
  }

  try {
    const market = db.createMarket(creatorId, question.trim(), options.map(o => o.trim()), channelId);
    if (!market) {
      return { success: false, error: 'Failed to create market in database' };
    }
    return { success: true, market };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error creating market:', errorMessage);
    return { success: false, error: `Failed to create market: ${errorMessage}` };
  }
}

export function placeBet(
  userId: string,
  username: string,
  marketId: number,
  optionIndex: number,
  amount: number
): PlaceBetResult {
  // Ensure user exists
  const user = ensureUser(userId, username);

  // Get market
  const market = db.getMarketWithDetails(marketId);
  if (!market) {
    return { success: false, error: 'Market not found' };
  }

  if (market.status !== 'open') {
    return { success: false, error: 'Market is not open for betting' };
  }

  // Validate option
  if (optionIndex < 0 || optionIndex >= market.parsedOptions.length) {
    return { success: false, error: 'Invalid option selected' };
  }

  // Validate amount
  if (amount < MIN_BET) {
    return { success: false, error: `Minimum bet is ${MIN_BET} coins` };
  }

  if (amount > MAX_BET) {
    return { success: false, error: `Maximum bet is ${MAX_BET} coins` };
  }

  if (amount > user.balance) {
    return { success: false, error: `Insufficient balance. You have ${user.balance} coins` };
  }

  try {
    const bet = db.placeBet(marketId, userId, optionIndex, amount);
    const newBalance = user.balance - amount;
    return { success: true, bet, newBalance };
  } catch (error) {
    return { success: false, error: 'Failed to place bet' };
  }
}

export function cancelBet(
  betId: number,
  requesterId: string
): { success: boolean; refundAmount?: number; error?: string } {
  // Get the bet
  const bet = db.getBet(betId);
  if (!bet) {
    return { success: false, error: 'Bet not found' };
  }

  // Check ownership
  if (bet.user_id !== requesterId) {
    return { success: false, error: 'You can only cancel your own bets' };
  }

  // Check if market is still open
  const market = db.getMarket(bet.market_id);
  if (!market) {
    return { success: false, error: 'Market not found' };
  }

  if (market.status !== 'open') {
    return { success: false, error: 'Cannot cancel bet - market is no longer open' };
  }

  try {
    db.cancelBet(betId);
    return { success: true, refundAmount: bet.amount };
  } catch (error) {
    return { success: false, error: 'Failed to cancel bet' };
  }
}

export function resolveMarket(
  marketId: number,
  winningOptionIndex: number,
  requesterId: string
): ResolveMarketResult {
  const market = db.getMarketWithDetails(marketId);
  if (!market) {
    return { success: false, error: 'Market not found' };
  }

  if (market.creator_id !== requesterId) {
    return { success: false, error: 'Only the market creator can resolve this market' };
  }

  if (market.status === 'resolved') {
    return { success: false, error: 'Market is already resolved' };
  }

  if (winningOptionIndex < 0 || winningOptionIndex >= market.parsedOptions.length) {
    return { success: false, error: 'Invalid winning option' };
  }

  try {
    db.resolveMarket(marketId, winningOptionIndex);

    // Get winner details
    const bets = db.getBetsForMarket(marketId);
    const winners: Array<{ userId: string; username: string; payout: number }> = [];

    for (const bet of bets) {
      if (bet.option_index === winningOptionIndex && bet.payout && bet.payout > 0) {
        const user = db.getOrCreateUser(bet.user_id, '');
        winners.push({
          userId: bet.user_id,
          username: user.username,
          payout: bet.payout
        });
      }
    }

    return { success: true, winners };
  } catch (error) {
    return { success: false, error: 'Failed to resolve market' };
  }
}

export function cancelMarket(marketId: number, requesterId: string): { success: boolean; error?: string } {
  const market = db.getMarket(marketId);
  if (!market) {
    return { success: false, error: 'Market not found' };
  }

  if (market.creator_id !== requesterId) {
    return { success: false, error: 'Only the market creator can cancel this market' };
  }

  if (market.status === 'resolved') {
    return { success: false, error: 'Cannot cancel a resolved market' };
  }

  // Refund all bets
  const bets = db.getBetsForMarket(marketId);
  for (const bet of bets) {
    const user = db.getOrCreateUser(bet.user_id, '');
    db.updateUserBalance(bet.user_id, user.balance + bet.amount);
  }

  // Close the market (we use 'closed' status for cancelled markets)
  db.closeMarket(marketId);

  return { success: true };
}

export function getMarketDetails(marketId: number): db.MarketWithDetails | undefined {
  return db.getMarketWithDetails(marketId);
}

export function getOpenMarkets(channelId?: string): db.Market[] {
  return db.getOpenMarkets(channelId);
}

export function getUserBalance(userId: string, username: string): number {
  ensureUser(userId, username);
  return db.getUserBalance(userId);
}

export function getLeaderboard(limit: number = 10): db.User[] {
  return db.getLeaderboard(limit);
}

export function getUserActiveBets(userId: string): Array<db.Bet & { question: string }> {
  return db.getUserActiveBets(userId);
}

export function formatMarketOdds(market: db.MarketWithDetails): string[] {
  if (market.totalPool === 0) {
    return market.parsedOptions.map(() => 'N/A');
  }

  return market.optionTotals.map(total => {
    if (total === 0) return '∞:1';
    const impliedOdds = (market.totalPool / total).toFixed(2);
    return `${impliedOdds}:1`;
  });
}

export function formatMarketPercentages(market: db.MarketWithDetails): string[] {
  if (market.totalPool === 0) {
    return market.parsedOptions.map(() => '0%');
  }

  return market.optionTotals.map(total => {
    const percentage = ((total / market.totalPool) * 100).toFixed(1);
    return `${percentage}%`;
  });
}

export { STARTING_BALANCE, MIN_BET, MAX_BET };
