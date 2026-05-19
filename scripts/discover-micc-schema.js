/**
 * MiContact Center SQL Schema Discovery
 * Reconnaissance only — read-only, no changes to server.js
 * Run: node scripts/discover-micc-schema.js
 */
require('dotenv').config();
const sql = require('mssql');

const cfg = {
  user:     process.env.MSSQL_USER,
  password: process.env.MSSQL_PASS,
  server:   process.env.MSSQL_SERVER,
  database: process.env.MSSQL_DB || 'CCMStatisticalData',
  options: {
    instanceName:           process.env.MSSQL_INSTANCE,
    trustServerCertificate: true,
    encrypt:                false,
  },
  connectionTimeout: 10000,
  requestTimeout:    20000,
};

const KEYWORDS    = ['queue', 'realtime', 'now', 'stat', 'monitor'];
const EXACT_WANTS = ['queuenow','queuebyperiod','queuerealtime','tblconfig_queue'];

async function run() {
  console.log(`Connecting to ${cfg.server} / ${cfg.database} as ${cfg.user}...\n`);
  const pool = await sql.connect(cfg);
  console.log('Connected.\n');

  // 1. List all tables
  const allTables = await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM   INFORMATION_SCHEMA.TABLES
    WHERE  TABLE_TYPE IN ('BASE TABLE','VIEW')
    ORDER  BY TABLE_NAME
  `);

  // Filter to matching tables
  const matching = allTables.recordset.filter(t => {
    const name = t.TABLE_NAME.toLowerCase();
    return KEYWORDS.some(k => name.includes(k)) || EXACT_WANTS.some(k => name === k);
  });

  console.log(`=== ALL TABLES (${allTables.recordset.length} total, ${matching.length} matching) ===\n`);
  allTables.recordset.forEach(t => {
    const mark = matching.find(m => m.TABLE_NAME === t.TABLE_NAME) ? '  ◀' : '';
    console.log(`  ${t.TABLE_SCHEMA}.${t.TABLE_NAME}${mark}`);
  });
  console.log('');

  // 2. Deep dive each matching table
  for (const t of matching) {
    const fullName = `[${t.TABLE_SCHEMA}].[${t.TABLE_NAME}]`;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`TABLE: ${fullName}  (${t.TABLE_TYPE})`);
    console.log('='.repeat(70));

    // Columns
    try {
      const cols = await pool.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
        FROM   INFORMATION_SCHEMA.COLUMNS
        WHERE  TABLE_NAME = '${t.TABLE_NAME}' AND TABLE_SCHEMA = '${t.TABLE_SCHEMA}'
        ORDER  BY ORDINAL_POSITION
      `);
      console.log('\nCOLUMNS:');
      cols.recordset.forEach(c => {
        const len = c.CHARACTER_MAXIMUM_LENGTH ? `(${c.CHARACTER_MAXIMUM_LENGTH})` : '';
        console.log(`  ${c.COLUMN_NAME.padEnd(40)} ${(c.DATA_TYPE + len).padEnd(20)} ${c.IS_NULLABLE === 'YES' ? 'nullable' : ''}`);
      });
    } catch (e) {
      console.log(`  [columns error: ${e.message.split('\n')[0]}]`);
    }

    // Row count
    try {
      const cnt = await pool.request().query(`SELECT COUNT(*) AS n FROM ${fullName}`);
      console.log(`\nROW COUNT: ${cnt.recordset[0].n}`);
    } catch (e) {
      console.log(`\nROW COUNT: [error: ${e.message.split('\n')[0]}]`);
    }

    // Top 3 rows
    try {
      const rows = await pool.request().query(`SELECT TOP 3 * FROM ${fullName}`);
      if (rows.recordset.length === 0) {
        console.log('\nSAMPLE ROWS: (empty table)');
      } else {
        console.log('\nSAMPLE ROWS:');
        rows.recordset.forEach((r, i) => console.log(`  [${i}] ${JSON.stringify(r)}`));
      }
    } catch (e) {
      console.log(`\nSAMPLE ROWS: [error: ${e.message.split('\n')[0]}]`);
    }
  }

  // 3. Also try CCMData in case it has real-time tables
  console.log(`\n\n${'='.repeat(70)}`);
  console.log('CHECKING CCMData FOR REAL-TIME TABLES');
  console.log('='.repeat(70));
  try {
    const ccm = await pool.request().query(`
      SELECT TABLE_NAME FROM CCMData.INFORMATION_SCHEMA.TABLES
      WHERE  TABLE_TYPE IN ('BASE TABLE','VIEW')
      ORDER  BY TABLE_NAME
    `);
    const ccmMatch = ccm.recordset.filter(t =>
      KEYWORDS.some(k => t.TABLE_NAME.toLowerCase().includes(k)) ||
      EXACT_WANTS.some(k => t.TABLE_NAME.toLowerCase() === k)
    );
    console.log(`\nCCMData tables: ${ccm.recordset.length} total, ${ccmMatch.length} matching`);
    ccmMatch.forEach(t => console.log(`  CCMData.dbo.${t.TABLE_NAME}`));
    if (ccm.recordset.length > 0 && ccmMatch.length === 0) {
      console.log('  (no keyword matches — all CCMData tables:)');
      ccm.recordset.forEach(t => console.log(`    ${t.TABLE_NAME}`));
    }
  } catch (e) {
    console.log(`  [CCMData access error: ${e.message.split('\n')[0]}]`);
  }

  console.log('\n\nDone.\n');
  process.exit(0);
}

run().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
