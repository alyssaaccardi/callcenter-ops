// ─── AI Receptionist Testing Platform — data layer ───────────────────────────
// QA management for the AI phone receptionist: rounds of test briefs generated
// from dev notes, assigned across testers, and collected back as feedback.
//
// SQLite rather than the JSON files the rest of the board uses. This is the
// most relational data on the board — rounds own briefs, briefs own
// assignments, assignments own submissions — and the submissions table has to
// be filtered by round, tester, account, call type and date at once. Doing
// that over rewritten JSON blobs would mean hand-rolling joins and would lose
// rows whenever two writes overlapped.

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = process.env.QA_DB_PATH || path.join(__dirname, '..', 'qa-platform.db');

const db = new Database(DB_PATH);
// WAL lets the dashboard read while a tester is submitting; without it a write
// blocks every reader for the duration.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  account_ref      TEXT,
  phone_numbers    TEXT,
  greeting_text    TEXT,
  outro_text       TEXT,
  timezone         TEXT,
  hours            TEXT,
  capture_intake   TEXT,
  confirm_answers  INTEGER DEFAULT 0,
  background_noise INTEGER DEFAULT 0,
  ai_model         TEXT,
  stt_provider     TEXT,
  tts_provider     TEXT,
  tts_voice        TEXT,
  disambiguation   INTEGER DEFAULT 0,
  call_flow_notes  TEXT,
  general_notes    TEXT,
  active           INTEGER DEFAULT 1,
  created_at       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_types (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  brand    TEXT NOT NULL,              -- 'AL' | 'RS'
  name     TEXT NOT NULL,
  UNIQUE(brand, name)
);

-- The roster is separate from board users on purpose: someone can be a tester
-- for a round without their board account changing, and a tester who leaves
-- keeps their submissions attributed.
CREATE TABLE IF NOT EXISTS testers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  active     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  dev_notes    TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',   -- draft | confirmed | assigned | closed
  created_by   TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  confirmed_at TEXT,
  closed_at    TEXT
);

CREATE TABLE IF NOT EXISTS briefs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id      INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  what_testing  TEXT,
  how_to_run    TEXT,                 -- JSON array of steps
  account_id    INTEGER REFERENCES accounts(id),
  account_name  TEXT,
  phone_number  TEXT,
  call_notes    TEXT,
  questions     TEXT,                 -- JSON array of feedback questions
  call_type     TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id    INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  brief_id    INTEGER NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  tester_id   INTEGER NOT NULL REFERENCES testers(id),
  queue_pos   INTEGER NOT NULL,
  assigned_at TEXT DEFAULT (datetime('now')),
  UNIQUE(brief_id, tester_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
  round_id      INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  brief_id      INTEGER NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  tester_id     INTEGER NOT NULL REFERENCES testers(id),
  answers       TEXT NOT NULL,        -- JSON [{question, answer}]
  improvement   TEXT,
  flagged       INTEGER DEFAULT 0,
  flag_note     TEXT,
  submitted_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS intakes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  brand   TEXT NOT NULL,
  name    TEXT NOT NULL,
  fields  TEXT NOT NULL,          -- JSON [{label, type, options[]}]
  notes   TEXT,
  UNIQUE(brand, name)
);

-- The call scripts testers work from: a persona, and the answers to give when
-- the bot asks intake questions. Reusable across rounds, and referenced during
-- generation so a brief can point at the script for its call type.
CREATE TABLE IF NOT EXISTS personas (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  call_type           TEXT NOT NULL,
  brand               TEXT NOT NULL,
  title               TEXT NOT NULL,
  phone               TEXT,
  persona             TEXT NOT NULL,
  opening_line        TEXT,
  answers             TEXT NOT NULL,     -- JSON [[question, answer], …]
  note                TEXT,
  special_instruction TEXT,
  transfer_capable    INTEGER DEFAULT 0,
  UNIQUE(brand, call_type)
);

CREATE TABLE IF NOT EXISTS doc_tabs (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT,
  sort       INTEGER DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_sub_round  ON submissions(round_id);
CREATE INDEX IF NOT EXISTS idx_sub_tester ON submissions(tester_id);
CREATE INDEX IF NOT EXISTS idx_sub_flag   ON submissions(flagged);
CREATE INDEX IF NOT EXISTS idx_asn_round  ON assignments(round_id, tester_id);
CREATE INDEX IF NOT EXISTS idx_brief_round ON briefs(round_id);
`);

// ─── Seed data ───────────────────────────────────────────────────────────────
// Runs once. Guarded by row counts so a restart never duplicates or resurrects
// something an admin deliberately deleted.

const CALL_TYPES_AL = [
  'Traffic NC', 'PI NC', 'Divorce NC', 'Med Mal NC', 'Criminal NC', 'Other NC',
  'Existing Client', 'General Call', 'Court Call', 'Judge Calls', 'Spam Call',
  'General Legal Simple', 'Opposing Counsel', 'Government Agency', 'Child Custody',
  'Bankruptcy', 'Social Security Disability', 'Disability / Workers Comp',
  'Real Estate', 'Entertainment & Business Litigation', 'Immigration',
  'Landlord / Tenant', 'Employment Employee Side', 'Wills Trusts & Estates',
  'Employment Employer Side', 'Medical Providers', 'Insurance Adjusters',
];

const CALL_TYPES_RS = [
  'HVAC NC', 'HVAC EC', 'HVAC General', 'HVAC Default', 'HVAC Emergency',
  'HVAC Simple', 'HVAC Simple + Email', 'Plumbing New Client', 'Plumbing EC',
  'Plumbing General',
];

// The five questions every brief starts from. Generation may add test-specific
// ones, but these are the spine that makes rounds comparable to each other.
//
// "One thing that could have been better" is deliberately NOT in this list: the
// brief template makes it the closing item on every test, so it is a field of
// its own on the submission (submissions.improvement) and always renders last.
// Keeping it here too would have asked every tester the same thing twice.
const CORE_QUESTIONS = [
  'Did the greeting make it clear who you were speaking with and how it could help?',
  'Did the bot understand your reason for calling and ask relevant follow-up questions?',
  'Was the information accurate, clear, and easy to provide or understand?',
  'Did the call reach the right outcome, including a transfer when one was needed?',
  'How would you describe the caller’s confidence in the bot by the end of the call?',
];

const IMPROVEMENT_PROMPT =
  'Write one specific example from this call of something that could have been improved, with as much detail as possible.';

const DOC_TABS = [
  { slug: 'flow',     title: 'Flow',                  sort: 1, body: '' },
  { slug: 'overview', title: 'Overview',              sort: 2, body: '' },
  { slug: 'users',    title: 'Users',                 sort: 3, body: '' },
  { slug: 'devres',   title: 'Dev Platform Resource', sort: 4, body: '' },
  { slug: 'intakes',  title: 'Intakes',               sort: 5, body: '' },
];

function seed() {
  const { PERSONAS, ACCOUNTS, TRANSFER_CAPABLE, SHARED_GOAL } = require('./personas-seed');

  if (!db.prepare('SELECT COUNT(*) c FROM personas').get().c) {
    const ins = db.prepare(`INSERT OR IGNORE INTO personas
      (call_type, brand, title, phone, persona, opening_line, answers, note, special_instruction, transfer_capable)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (const p of PERSONAS) {
        ins.run(p.call_type, p.brand, p.title, p.phone, p.persona, p.opening_line || null,
                JSON.stringify(p.answers), p.note || null, p.special_instruction || null,
                TRANSFER_CAPABLE.includes(p.call_type) ? 1 : 0);
      }
    })();
  }

  // The two real test accounts. Seeded only when the library is empty, so an
  // admin editing or removing them is never undone by a restart.
  if (!db.prepare('SELECT COUNT(*) c FROM accounts').get().c) {
    const ins = db.prepare('INSERT INTO accounts (name, phone_numbers, general_notes, active) VALUES (?,?,?,1)');
    db.transaction(() => {
      for (const a of ACCOUNTS) ins.run(a.name, a.phone_numbers, a.general_notes);
    })();
  }

  const haveTypes = db.prepare('SELECT COUNT(*) c FROM call_types').get().c;
  if (!haveTypes) {
    const ins = db.prepare('INSERT OR IGNORE INTO call_types (brand, name) VALUES (?, ?)');
    db.transaction(() => {
      for (const n of CALL_TYPES_AL) ins.run('AL', n);
      for (const n of CALL_TYPES_RS) ins.run('RS', n);
    })();
  }
  const insTab = db.prepare(
    'INSERT OR IGNORE INTO doc_tabs (slug, title, body, sort) VALUES (?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const t of DOC_TABS) insTab.run(t.slug, t.title, t.body, t.sort);
  })();

  // Seed the two reference pages that already have content to carry over.
  const tab = db.prepare('SELECT body FROM doc_tabs WHERE slug = ?');
  const setTab = db.prepare("UPDATE doc_tabs SET body = ?, updated_at = datetime('now'), updated_by = 'seed' WHERE slug = ?");
  if (tab.get('overview') && !tab.get('overview').body) {
    setTab.run(`${SHARED_GOAL}

WHAT THE BOT DOES
- Answers incoming calls
- Identifies the call type
- Collects contact info
- Collects intake info
- Transfers to the business owner (select call routes)
- Sends a message to the dev team to review

WHAT ROUND 1 IS TESTING
- How well the bot captures information from the caller (spelling, phone/email format)
- How well the bot transfers the call to the business owner
- How the bot handles a caller who doesn't know the answer to an intake question
- How the bot handles real-world call delays, e.g. "hold on a second, I'm getting in my car… ok, what did you ask me?"
- How the bot handles spam calls
- How the bot handles a service the company doesn't provide

CALL TYPES WITH TRANSFER CAPABILITY
${TRANSFER_CAPABLE.map(t => '- ' + t).join('\n')}

TEST ACCOUNTS
${ACCOUNTS.map(a => `- ${a.name} — ${a.phone_numbers} (${a.brand})`).join('\n')}

Round 1 target: 100 tests.`, 'overview');
  }
  if (tab.get('flow') && !tab.get('flow').body) {
    setTab.run(`HOW A ROUND WORKS

1. Coordinator pastes the dev team's raw notes into a new round and clicks Generate. One brief is produced per focus area found in the notes.
2. Coordinator reviews each brief, edits anything that needs it, assigns a test account, then clicks Confirm. Briefs lock at this point.
3. Coordinator sets how many tests each tester is doing this round and clicks Assign. Tests are spread as evenly as those numbers allow.
4. Testers log in and see their queue, one test at a time: the brief, the account and number to dial, what to expect on that account, and the feedback form.
5. Tester makes the call, fills in the form, and submits. They move straight to the next test in their queue.
6. Coordinator watches submissions arrive, flags anything notable, and exports the round as CSV or PDF for the dev team.

Rounds stay available after they close, so past results remain readable.`, 'flow');
  }
  const haveIntakes = db.prepare('SELECT COUNT(*) c FROM intakes').get().c;
  if (!haveIntakes) {
    const seedData = require('./intakes-seed');
    const ins = db.prepare('INSERT OR IGNORE INTO intakes (brand, name, fields) VALUES (?,?,?)');
    db.transaction(() => {
      for (const i of seedData) ins.run(i.brand, i.name, JSON.stringify(i.fields));
    })();
  }

}
seed();

module.exports = { db, CORE_QUESTIONS, IMPROVEMENT_PROMPT, CALL_TYPES_AL, CALL_TYPES_RS, DB_PATH };
