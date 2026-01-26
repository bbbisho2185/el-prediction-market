import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { initializeDatabase } from './database';
import { registerHandlers } from './slack';

// Validate required environment variables
const requiredEnvVars = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Error: Missing required environment variable ${envVar}`);
    process.exit(1);
  }
}

// Initialize database
console.log('Initializing database...');
initializeDatabase();
console.log('Database initialized.');

// Create Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO
});

// Register all handlers
registerHandlers(app);

// Start the app
(async () => {
  const port = parseInt(process.env.PORT || '3000', 10);
  await app.start(port);
  console.log(`⚡️ Prediction Market Bot is running on port ${port}!`);
  console.log('Commands available: /predict help');
})();
