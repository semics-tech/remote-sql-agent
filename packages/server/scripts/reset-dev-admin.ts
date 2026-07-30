/**
 * Put the local dev database back to a known administrator.
 *
 * The bootstrap password is generated once and printed once, which is right for
 * a real deployment and useless three days into local development when that log
 * line is long gone. Rather than weaken the product with a development sign-in
 * bypass — the kind of switch that eventually ships — this resets the dev
 * database to a password you already know.
 *
 * Refuses to run against anything that does not look like the local dev stack,
 * because "reset the administrator" is not a thing to do by accident.
 */
import { createInterface } from 'node:readline/promises';
import postgres from 'postgres';
import { hashPassword } from '../src/auth/passwords.js';

const DEV_URL = 'postgres://rsagent:rsagent_dev_password@localhost:5433/rsagent';
/** Documented in README.md, which is the point — it has to be knowable. */
const DEV_DEFAULT = 'rsagent-dev';
const url = process.env.RSAGENT_DATABASE_URL ?? DEV_URL;
const username = process.env.RSAGENT_BOOTSTRAP_ADMIN ?? 'admin';
const supplied = process.env.RSAGENT_BOOTSTRAP_ADMIN_PASSWORD;
const password = supplied ?? DEV_DEFAULT;

const host = new URL(url).hostname;
if (host !== 'localhost' && host !== '127.0.0.1') {
  console.error(
    `Refusing to reset the administrator on ${host}.\n` +
      'This script is for the local development database only.',
  );
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE username = ${username}
  `;

  if (existing && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Reset the password for "${username}" on the dev database? [y/N] `,
    );
    rl.close();
    if (!/^y(es)?$/iu.test(answer.trim())) {
      console.log('Left alone.');
      process.exit(0);
    }
  }

  const hash = await hashPassword(password);

  if (existing) {
    // Sessions cascade on delete, but this is an update — so drop them
    // explicitly. A password reset that leaves the old browser session signed
    // in has not really reset anything.
    await sql`DELETE FROM sessions WHERE user_id = ${existing.id}`;
    await sql`
      UPDATE users
         SET password_hash = ${hash},
             role = 'Admin',
             identity_provider = 'local',
             role_from_idp = false
       WHERE id = ${existing.id}
    `;
  } else {
    await sql`
      INSERT INTO users (username, password_hash, role, display_name, identity_provider, role_from_idp)
      VALUES (${username}, ${hash}, 'Admin', 'Bootstrap admin', 'local', false)
    `;
  }

  // The password is only echoed when it is the published development default,
  // which tells the reader nothing README.md does not. One supplied through the
  // environment is named rather than printed: it may well be reused elsewhere,
  // and this output lands in terminal scrollback and CI logs.
  console.log(
    `\n  ${existing ? 'Reset' : 'Created'} the development administrator.\n` +
      `    username: ${username}\n` +
      `    password: ${supplied ? 'as set in RSAGENT_BOOTSTRAP_ADMIN_PASSWORD' : DEV_DEFAULT}\n\n` +
      '  Local development only. Set RSAGENT_BOOTSTRAP_ADMIN_PASSWORD to choose another.\n',
  );
} finally {
  await sql.end();
}
