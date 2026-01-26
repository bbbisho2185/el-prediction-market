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

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*#${m.id}: ${m.question}*\nPool: ${details.totalPool} coins | Options: ${details.parsedOptions.length}`
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'View & Bet', emoji: true },
            action_id: 'view_market',
            value: String(m.id)
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

      const betLines = bets.map(b => {
        const details = market.getMarketDetails(b.market_id);
        const optionName = details ? details.parsedOptions[b.option_index] : 'Unknown';
        return `• Market #${b.market_id}: ${b.amount} coins on "${optionName}"`;
      });

      await respond({
        response_type: 'ephemeral',
        text: `🎲 *Your Active Bets*\n\n${betLines.join('\n')}`
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
        blocks: getMarketDetailBlocks(details, command.user_id)
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
    const metadata = JSON.parse(view.private_metadata || '{}');
    const channelId = metadata.channel_id;

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

    const result = market.createMarket(userId, username, question, options, channelId);

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
            text: `*#${result.market.id}: ${question}*\n\nCreated by <@${userId}>`
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

    const marketId = parseInt((action as any).value, 10);
    const details = market.getMarketDetails(marketId);

    if (!details) {
      await client.chat.postEphemeral({
        channel: (body as any).channel?.id || (body as any).container?.channel_id,
        user: body.user.id,
        text: 'Market not found.'
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: (body as any).channel?.id || (body as any).container?.channel_id,
      user: body.user.id,
      blocks: getMarketDetailBlocks(details, body.user.id)
    });
  });

  // Handle "Place a Bet" button
  app.action('open_bet_modal', async ({ ack, body, client, action }) => {
    await ack();

    const marketId = parseInt((action as any).value, 10);
    const details = market.getMarketDetails(marketId);

    if (!details) {
      return;
    }

    if (details.status !== 'open') {
      await client.chat.postEphemeral({
        channel: (body as any).channel?.id || (body as any).container?.channel_id,
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
          channel_id: (body as any).channel?.id || (body as any).container?.channel_id
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

    const marketId = parseInt((action as any).value, 10);
    const details = market.getMarketDetails(marketId);

    if (!details) {
      return;
    }

    if (details.creator_id !== body.user.id) {
      await client.chat.postEphemeral({
        channel: (body as any).channel?.id || (body as any).container?.channel_id,
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
          channel_id: (body as any).channel?.id || (body as any).container?.channel_id
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

    const marketId = parseInt((action as any).value, 10);
    const channelId = (body as any).channel?.id || (body as any).container?.channel_id;

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
          '• `/predict <id>` - View a specific market\n' +
          '• `/predict balance` - Check your coin balance\n' +
          '• `/predict mybets` - View your active bets\n' +
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

function getMarketDetailBlocks(details: db.MarketWithDetails, userId: string): any[] {
  const odds = market.formatMarketOdds(details);
  const percentages = market.formatMarketPercentages(details);

  const optionLines = details.parsedOptions.map((opt, i) => {
    const statusEmoji = details.status === 'resolved' && details.winning_option === i ? '✅ ' : '';
    return `${statusEmoji}*${i + 1}. ${opt}*\n   Pool: ${details.optionTotals[i]} coins | ${percentages[i]} | Odds: ${odds[i]}`;
  });

  const statusText = details.status === 'open' ? '🟢 Open' :
    details.status === 'resolved' ? '🏁 Resolved' : '🔴 Closed';

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Market #${details.id}`, emoji: true }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${details.question}*\n\n${statusText} | Total Pool: ${details.totalPool} coins`
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
    const actions: any[] = [
      {
        type: 'button',
        text: { type: 'plain_text', text: '💰 Place Bet', emoji: true },
        style: 'primary',
        action_id: 'open_bet_modal',
        value: String(details.id)
      }
    ];

    if (details.creator_id === userId) {
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: '✅ Resolve', emoji: true },
        action_id: 'open_resolve_modal',
        value: String(details.id)
      });
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: '🚫 Cancel', emoji: true },
        style: 'danger',
        action_id: 'cancel_market',
        value: String(details.id)
      });
    }

    blocks.push({
      type: 'actions',
      elements: actions
    });
  }

  return blocks;
}
