import { App, BlockAction, SlashCommand, ViewSubmitAction } from '@slack/bolt';
import * as market from './market';
import * as db from './database';

export function registerHandlers(app: App): void {
  // Slash command: /predict - Show help or create market
  app.command('/predict', async ({ command, ack, client, respond }) => {
    await ack();

    const args = command.text.trim();

    if (!args || args === 'help') {
      await respond({
        response_type: 'ephemeral',
        blocks: getHelpBlocks()
      });
      return;
    }

    if (args === 'balance') {
      const balance = market.getUserBalance(command.user_id, command.user_name);
      await respond({
        response_type: 'ephemeral',
        text: `💰 Your balance: *${balance}* coins`
      });
      return;
    }

    if (args === 'leaderboard') {
      const leaders = market.getLeaderboard(10);
      const leaderText = leaders.length > 0
        ? leaders.map((u, i) => `${i + 1}. ${u.username}: ${u.balance} coins`).join('\n')
        : 'No users yet!';
      await respond({
        response_type: 'in_channel',
        text: `🏆 *Leaderboard*\n\n${leaderText}`
      });
      return;
    }

    if (args === 'markets' || args === 'list') {
      // Check for expired markets first
      market.checkExpiredMarkets();
      const markets = market.getOpenMarkets(command.channel_id);
      if (markets.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: 'No open markets in this channel. Create one with `/predict create`!'
        });
        return;
      }

      const blocks = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '📊 Open Markets', emoji: true }
        },
        { type: 'divider' }
      ];

      for (const m of markets.slice(0, 10)) {
        const details = market.getMarketDetails(m.id);
        if (!details) continue;

        const mExpiryText = m.expires_at ? `\n⏰ Expires: ${m.expires_at} UTC` : '';
        const mFeaturedStar = m.featured ? '⭐ ' : '';
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${mFeaturedStar}*#${m.id}: ${m.question}*\nPool: ${details.totalPool} coins | Options: ${details.parsedOptions.length}${mExpiryText}`
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'View & Bet', emoji: true },
            action_id: 'view_market',
            value: JSON.stringify({ market_id: m.id, channel_id: command.channel_id })
          }
        } as any);
      }

      await respond({
        response_type: 'ephemeral',
        blocks: blocks as any
      });
      return;
    }

    if (args === 'mybets') {
      const bets = market.getUserActiveBets(command.user_id);
      if (bets.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: 'You have no active bets. Find markets with `/predict markets`!'
        });
        return;
      }

      const blocks: any[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🎲 Your Active Bets', emoji: true }
        },
        { type: 'divider' }
      ];

      for (const b of bets) {
        const details = market.getMarketDetails(b.market_id);
        const optionName = details ? details.parsedOptions[b.option_index] : 'Unknown';

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Market #${b.market_id}:* ${b.question}\n💰 ${b.amount} coins on "*${optionName}*"`
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Cancel Bet', emoji: true },
            style: 'danger',
            action_id: 'cancel_bet',
            value: JSON.stringify({ bet_id: b.id, channel_id: command.channel_id }),
            confirm: {
              title: { type: 'plain_text', text: 'Cancel Bet?' },
              text: { type: 'mrkdwn', text: `Are you sure you want to cancel your ${b.amount} coin bet on "${optionName}"? You will be refunded.` },
              confirm: { type: 'plain_text', text: 'Yes, Cancel' },
              deny: { type: 'plain_text', text: 'Keep Bet' }
            }
          }
        });
      }

      await respond({
        response_type: 'ephemeral',
        blocks: blocks
      });
      return;
    }

    if (args === 'history') {
      const history = db.getUserBetHistory(command.user_id, 20);
      if (history.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: 'You have no betting history yet. Place some bets with `/predict markets`!'
        });
        return;
      }

      const blocks: any[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '📜 Your Betting History', emoji: true }
        },
        { type: 'divider' }
      ];

      let totalWagered = 0;
      let totalWon = 0;
      let wins = 0;
      let losses = 0;

      for (const bet of history) {
        const options = JSON.parse(bet.options) as string[];
        const optionName = options[bet.option_index] || 'Unknown';
        totalWagered += bet.amount;

        let statusText: string;
        let emoji: string;

        if (bet.market_status === 'resolved') {
          const won = bet.winning_option === bet.option_index;
          if (won) {
            emoji = '✅';
            statusText = `Won +${bet.payout} coins`;
            totalWon += bet.payout || 0;
            wins++;
          } else {
            emoji = '❌';
            statusText = `Lost ${bet.amount} coins`;
            losses++;
          }
        } else if (bet.market_status === 'closed') {
          emoji = '🚫';
          statusText = 'Market cancelled (refunded)';
        } else {
          emoji = '⏳';
          statusText = 'Pending';
        }

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *Market #${bet.market_id}:* ${bet.question}\n` +
              `   Bet ${bet.amount} coins on "*${optionName}*" → ${statusText}`
          }
        });
      }

      // Add summary
      const netProfit = totalWon - totalWagered;
      const profitEmoji = netProfit >= 0 ? '📈' : '📉';

      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Summary (last ${history.length} bets):*\n` +
            `• Record: ${wins}W - ${losses}L\n` +
            `• Total wagered: ${totalWagered} coins\n` +
            `• Total won: ${totalWon} coins\n` +
            `• ${profitEmoji} Net profit: ${netProfit >= 0 ? '+' : ''}${netProfit} coins`
        }
      });

      await respond({
        response_type: 'ephemeral',
        blocks: blocks
      });
      return;
    }

    if (args === 'featured') {
      // Check for expired markets first
      market.checkExpiredMarkets();

      const featured = market.getFeaturedMarkets(command.channel_id);
      if (featured.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: 'No featured markets in this channel. Market creators can feature their markets from the market details view.'
        });
        return;
      }

      const blocks: any[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '⭐ Featured Markets', emoji: true }
        },
        { type: 'divider' }
      ];

      for (const m of featured.slice(0, 10)) {
        const details = market.getMarketDetails(m.id);
        if (!details) continue;

        const expiryText = m.expires_at ? `\n⏰ Expires: ${m.expires_at} UTC` : '';
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⭐ *#${m.id}: ${m.question}*\nPool: ${details.totalPool} coins | Options: ${details.parsedOptions.length}${expiryText}`
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'View & Bet', emoji: true },
            action_id: 'view_market',
            value: JSON.stringify({ market_id: m.id, channel_id: command.channel_id })
          }
        } as any);
      }

      await respond({
        response_type: 'ephemeral',
        blocks: blocks as any
      });
      return;
    }

    if (args.startsWith('search ')) {
      const keyword = args.substring(7).trim();
      if (!keyword) {
        await respond({
          response_type: 'ephemeral',
          text: 'Please provide a search term. Usage: `/predict search <keyword>`'
        });
        return;
      }

      const results = market.searchMarkets(keyword, command.channel_id);
      if (results.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: `No markets found matching "${keyword}". Try a different search term.`
        });
        return;
      }

      const blocks: any[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: `🔍 Search: "${keyword}"`, emoji: true }
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Found ${results.length} market${results.length !== 1 ? 's' : ''}` }]
        },
        { type: 'divider' }
      ];

      for (const m of results.slice(0, 10)) {
        const details = market.getMarketDetails(m.id);
        if (!details) continue;

        const statusEmoji = m.status === 'open' ? '🟢' : m.status === 'resolved' ? '🏁' : '🔴';
        const featuredStar = m.featured ? '⭐ ' : '';
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${featuredStar}${statusEmoji} *#${m.id}: ${m.question}*\nPool: ${details.totalPool} coins | Status: ${m.status}`
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'View Details', emoji: true },
            action_id: 'view_market',
            value: JSON.stringify({ market_id: m.id, channel_id: command.channel_id })
          }
        } as any);
      }

      await respond({
        response_type: 'ephemeral',
        blocks: blocks as any
      });
      return;
    }

    if (args === 'create') {
      // Open modal for creating a market
      await client.views.open({
        trigger_id: command.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'create_market_modal',
          private_metadata: JSON.stringify({ channel_id: command.channel_id }),
          title: { type: 'plain_text', text: 'Create Prediction Market' },
          submit: { type: 'plain_text', text: 'Create' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'input',
              block_id: 'question_block',
              label: { type: 'plain_text', text: 'Question' },
              element: {
                type: 'plain_text_input',
                action_id: 'question_input',
                placeholder: { type: 'plain_text', text: 'What will happen?' },
                max_length: 200
              }
            },
            {
              type: 'input',
              block_id: 'options_block',
              label: { type: 'plain_text', text: 'Options (one per line, 2-10 options)' },
              element: {
                type: 'plain_text_input',
                action_id: 'options_input',
                multiline: true,
                placeholder: { type: 'plain_text', text: 'Yes\nNo' }
              }
            },
            {
              type: 'input',
              block_id: 'expiration_block',
              optional: true,
              label: { type: 'plain_text', text: 'Expires in (optional)' },
              element: {
                type: 'static_select',
                action_id: 'expiration_select',
                placeholder: { type: 'plain_text', text: 'No expiration' },
                options: [
                  { text: { type: 'plain_text', text: '1 hour' }, value: '1h' },
                  { text: { type: 'plain_text', text: '6 hours' }, value: '6h' },
                  { text: { type: 'plain_text', text: '12 hours' }, value: '12h' },
                  { text: { type: 'plain_text', text: '1 day' }, value: '1d' },
                  { text: { type: 'plain_text', text: '3 days' }, value: '3d' },
                  { text: { type: 'plain_text', text: '1 week' }, value: '1w' },
                  { text: { type: 'plain_text', text: '2 weeks' }, value: '2w' },
                  { text: { type: 'plain_text', text: '1 month' }, value: '1m' }
                ]
              }
            }
          ]
        }
      });
      return;
    }

    // Check if viewing a specific market: /predict 123
    const marketId = parseInt(args, 10);
    if (!isNaN(marketId)) {
      const details = market.getMarketDetails(marketId);
      if (!details) {
        await respond({
          response_type: 'ephemeral',
          text: `Market #${marketId} not found.`
        });
        return;
      }

      await respond({
        response_type: 'ephemeral',
        blocks: getMarketDetailBlocks(details, command.user_id, command.channel_id)
      });
      return;
    }

    // Unknown command
    await respond({
      response_type: 'ephemeral',
      text: 'Unknown command. Use `/predict help` for available commands.'
    });
  });

  // Handle market creation modal submission
  app.view('create_market_modal', async ({ ack, view, body, client }) => {
    const question = view.state.values.question_block.question_input.value || '';
    const optionsText = view.state.values.options_block.options_input.value || '';
    const options = optionsText.split('\n').map(o => o.trim()).filter(o => o.length > 0);
    const expirationValue = view.state.values.expiration_block?.expiration_select?.selected_option?.value;
    const metadata = JSON.parse(view.private_metadata || '{}');
    const channelId = metadata.channel_id;

    // Calculate expiration date
    let expiresAt: string | undefined;
    if (expirationValue) {
      const now = new Date();
      const durations: Record<string, number> = {
        '1h': 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '12h': 12 * 60 * 60 * 1000,
        '1d': 24 * 60 * 60 * 1000,
        '3d': 3 * 24 * 60 * 60 * 1000,
        '1w': 7 * 24 * 60 * 60 * 1000,
        '2w': 14 * 24 * 60 * 60 * 1000,
        '1m': 30 * 24 * 60 * 60 * 1000
      };
      const ms = durations[expirationValue];
      if (ms) {
        const expDate = new Date(now.getTime() + ms);
        expiresAt = expDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      }
    }

    if (options.length < 2) {
      await ack({
        response_action: 'errors',
        errors: {
          options_block: 'Please provide at least 2 options'
        }
      });
      return;
    }

    if (options.length > 10) {
      await ack({
        response_action: 'errors',
        errors: {
          options_block: 'Maximum 10 options allowed'
        }
      });
      return;
    }

    await ack();

    const userId = body.user.id;
    const username = body.user.name || body.user.id;

    const result = market.createMarket(userId, username, question, options, channelId, expiresAt);

    if (!result.success || !result.market) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `❌ Failed to create market: ${result.error}`
      });
      return;
    }

    // Announce the new market in the channel
    const details = market.getMarketDetails(result.market.id);
    if (!details) return;

    await client.chat.postMessage({
      channel: channelId,
      text: `New prediction market created: ${question}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🎰 New Prediction Market!', emoji: true }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*#${result.market.id}: ${question}*\n\nCreated by <@${userId}>${expiresAt ? `\n⏰ Expires: ${expiresAt} UTC` : ''}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Options:*\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n')
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '💰 Place a Bet', emoji: true },
              style: 'primary',
              action_id: 'open_bet_modal',
              value: String(result.market.id)
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '📊 View Details', emoji: true },
              action_id: 'view_market',
              value: String(result.market.id)
            }
          ]
        }
      ]
    });
  });

  // Handle "View & Bet" button
  app.action('view_market', async ({ ack, body, client, action }) => {
    await ack();

    let marketId: number;
    let channelId: string;

    // Parse the value - could be JSON object or just a number
    const actionValue = (action as any).value;
    try {
      const parsed = JSON.parse(actionValue);
      if (typeof parsed === 'object' && parsed !== null) {
        marketId = parsed.market_id;
        channelId = parsed.channel_id;
      } else {
        marketId = parsed;
        channelId = (body as any).channel?.id || (body as any).container?.channel_id;
      }
    } catch {
      marketId = parseInt(actionValue, 10);
      channelId = (body as any).channel?.id || (body as any).container?.channel_id;
    }

    const details = market.getMarketDetails(marketId);

    if (!details) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: 'Market not found.'
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      blocks: getMarketDetailBlocks(details, body.user.id, channelId)
    });
  });

  // Handle "Place a Bet" button
  app.action('open_bet_modal', async ({ ack, body, client, action }) => {
    await ack();

    let marketId: number;
    let channelId: string;

    // Parse the value - could be JSON object or just a number
    const actionValue = (action as any).value;
    try {
      const parsed = JSON.parse(actionValue);
      if (typeof parsed === 'object' && parsed !== null) {
        marketId = parsed.market_id;
        channelId = parsed.channel_id;
      } else {
        marketId = parsed;
        channelId = (body as any).channel?.id || (body as any).container?.channel_id;
      }
    } catch {
      marketId = parseInt(actionValue, 10);
      channelId = (body as any).channel?.id || (body as any).container?.channel_id;
    }

    const details = market.getMarketDetails(marketId);

    if (!details) {
      return;
    }

    if (details.status !== 'open') {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: 'This market is no longer open for betting.'
      });
      return;
    }

    const options = details.parsedOptions.map((opt, i) => ({
      text: { type: 'plain_text' as const, text: opt },
      value: String(i)
    }));

    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'place_bet_modal',
        private_metadata: JSON.stringify({
          market_id: marketId,
          channel_id: channelId
        }),
        title: { type: 'plain_text', text: 'Place Your Bet' },
        submit: { type: 'plain_text', text: 'Place Bet' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${details.question}*\n\nTotal pool: ${details.totalPool} coins`
            }
          },
          { type: 'divider' },
          {
            type: 'input',
            block_id: 'option_block',
            label: { type: 'plain_text', text: 'Select your prediction' },
            element: {
              type: 'static_select',
              action_id: 'option_select',
              placeholder: { type: 'plain_text', text: 'Choose an option' },
              options: options
            }
          },
          {
            type: 'input',
            block_id: 'amount_block',
            label: { type: 'plain_text', text: 'Bet amount (coins)' },
            element: {
              type: 'plain_text_input',
              action_id: 'amount_input',
              placeholder: { type: 'plain_text', text: '100' }
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Your balance: ${market.getUserBalance(body.user.id, (body.user as any).name || body.user.id)} coins`
              }
            ]
          }
        ]
      }
    });
  });

  // Handle bet submission
  app.view('place_bet_modal', async ({ ack, view, body, client }) => {
    const metadata = JSON.parse(view.private_metadata || '{}');
    const marketId = metadata.market_id;
    const channelId = metadata.channel_id;

    const optionIndex = parseInt(view.state.values.option_block.option_select.selected_option?.value || '-1', 10);
    const amountStr = view.state.values.amount_block.amount_input.value || '0';
    const amount = parseInt(amountStr, 10);

    if (isNaN(amount) || amount <= 0) {
      await ack({
        response_action: 'errors',
        errors: {
          amount_block: 'Please enter a valid positive number'
        }
      });
      return;
    }

    const userId = body.user.id;
    const username = body.user.name || body.user.id;

    const result = market.placeBet(userId, username, marketId, optionIndex, amount);

    if (!result.success) {
      await ack({
        response_action: 'errors',
        errors: {
          amount_block: result.error || 'Failed to place bet'
        }
      });
      return;
    }

    await ack();

    const details = market.getMarketDetails(marketId);
    const optionName = details?.parsedOptions[optionIndex] || 'Unknown';

    await client.chat.postMessage({
      channel: channelId,
      text: `<@${userId}> bet ${amount} coins on "${optionName}" in market #${marketId}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🎲 <@${userId}> bet *${amount} coins* on "*${optionName}*"\n📊 Market #${marketId}: ${details?.question || 'Unknown'}`
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `New pool total: ${details?.totalPool || 0} coins`
            }
          ]
        }
      ]
    });
  });

  // Handle resolve market button
  app.action('open_resolve_modal', async ({ ack, body, client, action }) => {
    await ack();

    let marketId: number;
    let channelId: string;

    // Parse the value - could be JSON object or just a number
    const actionValue = (action as any).value;
    try {
      const parsed = JSON.parse(actionValue);
      if (typeof parsed === 'object' && parsed !== null) {
        marketId = parsed.market_id;
        channelId = parsed.channel_id;
      } else {
        marketId = parsed;
        channelId = (body as any).channel?.id || (body as any).container?.channel_id;
      }
    } catch {
      marketId = parseInt(actionValue, 10);
      channelId = (body as any).channel?.id || (body as any).container?.channel_id;
    }

    const details = market.getMarketDetails(marketId);

    if (!details) {
      return;
    }

    if (details.creator_id !== body.user.id) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: 'Only the market creator can resolve this market.'
      });
      return;
    }

    const options = details.parsedOptions.map((opt, i) => ({
      text: { type: 'plain_text' as const, text: opt },
      value: String(i)
    }));

    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'resolve_market_modal',
        private_metadata: JSON.stringify({
          market_id: marketId,
          channel_id: channelId
        }),
        title: { type: 'plain_text', text: 'Resolve Market' },
        submit: { type: 'plain_text', text: 'Resolve' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${details.question}*\n\nSelect the winning outcome:`
            }
          },
          {
            type: 'input',
            block_id: 'winner_block',
            label: { type: 'plain_text', text: 'Winning Option' },
            element: {
              type: 'static_select',
              action_id: 'winner_select',
              placeholder: { type: 'plain_text', text: 'Select the winner' },
              options: options
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '⚠️ This action cannot be undone. Winners will receive their payouts immediately.'
              }
            ]
          }
        ]
      }
    });
  });

  // Handle market resolution
  app.view('resolve_market_modal', async ({ ack, view, body, client }) => {
    await ack();

    const metadata = JSON.parse(view.private_metadata || '{}');
    const marketId = metadata.market_id;
    const channelId = metadata.channel_id;

    const winningIndex = parseInt(view.state.values.winner_block.winner_select.selected_option?.value || '-1', 10);

    const userId = body.user.id;
    const details = market.getMarketDetails(marketId);

    if (!details) {
      return;
    }

    const result = market.resolveMarket(marketId, winningIndex, userId);

    if (!result.success) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `❌ Failed to resolve market: ${result.error}`
      });
      return;
    }

    const winningOption = details.parsedOptions[winningIndex];
    const winnersText = result.winners && result.winners.length > 0
      ? result.winners.map(w => `<@${w.userId}>: +${w.payout} coins`).join('\n')
      : 'No winners';

    await client.chat.postMessage({
      channel: channelId,
      text: `Market #${marketId} resolved! Winner: ${winningOption}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🏁 Market Resolved!', emoji: true }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*#${marketId}: ${details.question}*\n\n✅ Winning answer: *${winningOption}*`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Winners:*\n${winnersText}`
          }
        }
      ]
    });
  });

  // Handle cancel market
  app.action('cancel_market', async ({ ack, body, client, action }) => {
    await ack();

    let marketId: number;
    let channelId: string;

    // Parse the value - could be JSON object or just a number
    const actionValue = (action as any).value;
    try {
      const parsed = JSON.parse(actionValue);
      if (typeof parsed === 'object' && parsed !== null) {
        marketId = parsed.market_id;
        channelId = parsed.channel_id;
      } else {
        marketId = parsed;
        channelId = (body as any).channel?.id || (body as any).container?.channel_id;
      }
    } catch {
      marketId = parseInt(actionValue, 10);
      channelId = (body as any).channel?.id || (body as any).container?.channel_id;
    }

    const result = market.cancelMarket(marketId, body.user.id);

    if (!result.success) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: `❌ ${result.error}`
      });
      return;
    }

    await client.chat.postMessage({
      channel: channelId,
      text: `Market #${marketId} has been cancelled. All bets have been refunded.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🚫 Market #${marketId} has been cancelled by <@${body.user.id}>.\n\n💰 All bets have been refunded.`
          }
        }
      ]
    });
  });

  // Handle cancel bet
  app.action('cancel_bet', async ({ ack, body, client, action }) => {
    await ack();

    let betId: number;
    let channelId: string;

    const actionValue = (action as any).value;
    try {
      const parsed = JSON.parse(actionValue);
      betId = parsed.bet_id;
      channelId = parsed.channel_id;
    } catch {
      betId = parseInt(actionValue, 10);
      channelId = (body as any).channel?.id || (body as any).container?.channel_id;
    }

    const result = market.cancelBet(betId, body.user.id);

    if (!result.success) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: `❌ ${result.error}`
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: `✅ Bet cancelled! ${result.refundAmount} coins have been refunded to your balance.`
    });
  });
  // Handle toggle featured
  app.action('toggle_featured', async ({ ack, body, client, action }) => {
    await ack();

    let marketId: number;
    let channelId: string;

    const actionValue = (action as any).value;
    try {
      const parsed = JSON.parse(actionValue);
      if (typeof parsed === 'object' && parsed !== null) {
        marketId = parsed.market_id;
        channelId = parsed.channel_id;
      } else {
        marketId = parsed;
        channelId = (body as any).channel?.id || (body as any).container?.channel_id;
      }
    } catch {
      marketId = parseInt(actionValue, 10);
      channelId = (body as any).channel?.id || (body as any).container?.channel_id;
    }

    const result = market.toggleFeatured(marketId, body.user.id);

    if (!result.success) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: `❌ ${result.error}`
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: result.featured
        ? `⭐ Market #${marketId} is now featured! Others can find it with \`/predict featured\`.`
        : `Market #${marketId} has been unfeatured.`
    });
  });
}

function getHelpBlocks(): any[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🎰 Prediction Market Bot', emoji: true }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Create prediction markets and bet with fake money!'
      }
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Commands:*\n' +
          '• `/predict create` - Create a new prediction market\n' +
          '• `/predict markets` - List open markets in this channel\n' +
          '• `/predict featured` - View featured markets\n' +
          '• `/predict search <keyword>` - Search markets by keyword\n' +
          '• `/predict <id>` - View a specific market\n' +
          '• `/predict balance` - Check your coin balance\n' +
          '• `/predict mybets` - View your active bets\n' +
          '• `/predict history` - View your betting history & stats\n' +
          '• `/predict leaderboard` - See the top traders\n' +
          '• `/predict help` - Show this help message'
      }
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `💰 Everyone starts with ${market.STARTING_BALANCE} coins. Good luck!`
        }
      ]
    }
  ];
}

function getMarketDetailBlocks(details: db.MarketWithDetails, userId: string, channelId?: string): any[] {
  const odds = market.formatMarketOdds(details);
  const percentages = market.formatMarketPercentages(details);

  const optionLines = details.parsedOptions.map((opt, i) => {
    const statusEmoji = details.status === 'resolved' && details.winning_option === i ? '✅ ' : '';
    return `${statusEmoji}*${i + 1}. ${opt}*\n   Pool: ${details.optionTotals[i]} coins | ${percentages[i]} | Odds: ${odds[i]}`;
  });

  const statusText = details.status === 'open' ? '🟢 Open' :
    details.status === 'resolved' ? '🏁 Resolved' : '🔴 Closed';
  const featuredText = details.featured ? ' ⭐ Featured' : '';
  const expiryText = details.expires_at ? `\n⏰ Expires: ${details.expires_at} UTC` : '';

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Market #${details.id}`, emoji: true }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${details.question}*\n\n${statusText}${featuredText} | Total Pool: ${details.totalPool} coins${expiryText}`
      }
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Options:*\n\n' + optionLines.join('\n\n')
      }
    }
  ];

  if (details.status === 'open') {
    const buttonValue = channelId
      ? JSON.stringify({ market_id: details.id, channel_id: channelId })
      : String(details.id);

    const actions: any[] = [
      {
        type: 'button',
        text: { type: 'plain_text', text: '💰 Place Bet', emoji: true },
        style: 'primary',
        action_id: 'open_bet_modal',
        value: buttonValue
      }
    ];

    if (details.creator_id === userId) {
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: '✅ Resolve', emoji: true },
        action_id: 'open_resolve_modal',
        value: buttonValue
      });
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: details.featured ? '⭐ Unfeature' : '⭐ Feature', emoji: true },
        action_id: 'toggle_featured',
        value: buttonValue
      });
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: '🚫 Cancel', emoji: true },
        style: 'danger',
        action_id: 'cancel_market',
        value: buttonValue
      });
    }

    blocks.push({
      type: 'actions',
      elements: actions
    });
  }

  return blocks;
}
