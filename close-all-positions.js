/**
 * Script to close ALL positions on ALL exchanges
 * 
 * Usage: node close-all-positions.js
 */

const API_URL = process.env.VITE_API_URL || 'http://localhost:4000';
const TOKEN = process.argv[2] || process.env.AUTH_TOKEN;

if (!TOKEN) {
  console.error('❌ Error: No auth token provided');
  console.log('\nUsage:');
  console.log('  node close-all-positions.js <your-auth-token>');
  console.log('\nOr set environment variable:');
  console.log('  export AUTH_TOKEN=your-token-here');
  console.log('  node close-all-positions.js\n');
  process.exit(1);
}

async function closeAllPositions() {
  try {
    console.log('🔄 Closing ALL positions on ALL exchanges...\n');
    
    const response = await fetch(`${API_URL}/positions/close-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`
      }
    });

    const result = await response.json();
    
    console.log('\n📊 Result:', result.status);
    console.log('💬 Message:', result.message);
    
    if (result.details) {
      console.log('\n📋 Details:');
      console.log('  Total Processed:', result.details.totalProcessed);
      console.log('  Successful:', result.details.successful);
      console.log('  Failed:', result.details.failed);
      
      if (result.details.results && result.details.results.length > 0) {
        console.log('\n📝 Breakdown:');
        result.details.results.forEach((r, i) => {
          if (r.success) {
            console.log(`  ✅ ${r.exchange}: ${r.symbol} (${r.side}) - Size: ${r.size}, PnL: $${r.pnl?.toFixed(2) || '0.00'}`);
          } else {
            console.log(`  ❌ ${r.exchange}: ${r.symbol || 'Exchange error'} - ${r.error}`);
          }
        });
      }
    }
    
    console.log('\n✅ Operation completed!\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

closeAllPositions();
