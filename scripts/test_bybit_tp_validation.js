/**
 * scripts/test_bybit_tp_validation.js
 * 
 * Tests Bybit's /v5/fgridbot/validate endpoint to determine:
 * 1. Does Bybit accept fractional/decimal Take Profit (e.g. 0.8 or 0.80)?
 * 2. Does Bybit strictly require whole integers (e.g. 1, 2, 3)?
 * 3. Does Bybit accept numbers vs strings?
 */

require('dotenv').config();
const crypto = require('crypto');
const https = require('https');

const apiKey = process.env.BYBIT_BOT_API_KEY || '';
const apiSecret = process.env.BYBIT_BOT_API_SECRET || '';
const baseUrl = 'https://api.bybit.com';

function signedRequest(endpoint, payload, method = 'POST') {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const recvWindow = '20000';
    const bodyStr = payload ? JSON.stringify(payload) : '';

    const preHash = timestamp + apiKey + recvWindow + bodyStr;
    const signature = crypto.createHmac('sha256', apiSecret).update(preHash).digest('hex');

    const parsedUrl = new URL(baseUrl + endpoint);
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature,
        'X-BAPI-RECV-WINDOW': recvWindow
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data, status: res.statusCode });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function run() {
  console.log('Testing Bybit Futures Grid Bot validation endpoint...');
  console.log('API Key configured:', apiKey ? 'YES (' + apiKey.slice(-4) + ')' : 'NO');

  // Test symbol: BTCUSDT (current price ~95000)
  // Let's get current BTC price first
  const tickerRes = await new Promise(res => {
    https.get('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT', r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)?.result?.list?.[0]));
    });
  });

  const btcPrice = parseFloat(tickerRes?.lastPrice || '95000');
  console.log('Current BTC Price:', btcPrice);

  const minPrice = (btcPrice * 0.80).toFixed(1);
  const maxPrice = (btcPrice * 1.35).toFixed(1);

  const testCases = [
    { label: 'String "1"', tpVal: '1' },
    { label: 'String "1.0"', tpVal: '1.0' },
    { label: 'String "0.8"', tpVal: '0.8' },
    { label: 'String "0.80"', tpVal: '0.80' },
    { label: 'Number 1', tpVal: 1 },
    { label: 'Number 0.8', tpVal: 0.8 },
  ];

  for (const tc of testCases) {
    const payload = {
      symbol: 'BTCUSDT',
      grid_mode: 3,          // 3 = Short
      direction: 2,          // 2 = Short
      min_price: minPrice,
      max_price: maxPrice,
      cell_number: 80,
      leverage: '2',
      grid_type: 2,          // 2 = Geometric
      total_investment: '100',
      tp_sl_type: 1,         // 1 = Percentage
      take_profit_per: tc.tpVal
    };

    console.log(`\nTesting take_profit_per = ${tc.label}...`);
    try {
      const res = await signedRequest('/v5/fgridbot/validate', payload, 'POST');
      console.log(`Response: retCode: ${res.retCode}, retMsg: "${res.retMsg}"`);
      if (res.result) console.log('Result:', res.result);
      if (res.retCode !== 0) console.log('Full Error:', JSON.stringify(res));
    } catch (e) {
      console.error('Request failed:', e.message);
    }
  }
}

run().catch(console.error);
