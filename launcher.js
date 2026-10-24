/**
 * launcher.js
 * 
 * Auto-Restart Supervisor for Bybit Decay Screener.
 * Spawns server.js as a managed child process.
 * When server.js performs its scheduled daily clean exit (exit code 0),
 * launcher.js logs the event and cleanly respawns a fresh server instance in 2 seconds.
 * Keeps memory at absolute baseline without Docker/Northflank service interruption.
 */

require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

let child = null;
let isShuttingDown = false;

function startServer() {
  if (isShuttingDown) return;

  console.log(`\n================================================================`);
  console.log(`  [Supervisor] 🚀 Spawning fresh Bybit Decay Server instance...`);
  console.log(`================================================================\n`);

  child = spawn('node', [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    if (isShuttingDown) return;

    if (code === 0) {
      console.log(`\n[Supervisor] 🔄 Clean daily restart detected (exit code: 0).`);
      console.log(`[Supervisor] ⏳ Respawning fresh server process in 2 seconds...\n`);
      setTimeout(startServer, 2000);
    } else {
      console.warn(`\n[Supervisor] ⚠️ Process exited with code: ${code}, signal: ${signal}. Respawning in 5 seconds...`);
      setTimeout(startServer, 5000);
    }
  });

  child.on('error', (err) => {
    console.error('[Supervisor] Failed to spawn child process:', err.message);
    setTimeout(startServer, 5000);
  });
}

// Graceful signal handling for supervisor itself
process.on('SIGINT', () => {
  isShuttingDown = true;
  if (child) child.kill('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  isShuttingDown = true;
  if (child) child.kill('SIGTERM');
  process.exit(0);
});

startServer();
