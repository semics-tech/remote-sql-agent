// Demo only. Signs in to the control plane as the bootstrap admin, mints a
// single-use enrolment token for this worker's host name, and prints it.
//
// Exists so `docker compose up` needs no copy-paste: the dashboard flow
// (Estate > Add a worker) makes exactly these calls.

const base = process.env.RSAGENT_CONTROL_PLANE_URL ?? 'http://server:8080';
const username = process.env.RSAGENT_ADMIN_USER ?? 'admin';
const adminPassword = process.env.RSAGENT_ADMIN_PASSWORD ?? '';
const hostName = process.env.RSAGENT_WORKER_HOST ?? 'DEMO-SQLHOST01';

/** Minimal cookie jar: name -> value. */
const jar = new Map();

function remember(response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(),
      'x-rsagent-csrf': jar.get('rsagent_csrf') ?? '',
      ...init.headers,
    },
  });
  remember(response);
  if (!response.ok) {
    const error = new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function mint() {
  await call('/api/auth/config');
  await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password: adminPassword }),
  });
  const minted = await call('/api/enrolment-tokens', {
    method: 'POST',
    body: JSON.stringify({ hostName, credentialMode: 'token', capabilities: ['observe'] }),
  });
  return minted.token;
}

// Exit 78 (EX_CONFIG) means the server rejected the request (4xx: bad
// credentials, bad capability, rate limited). Retrying cannot fix that, so
// worker-entry.sh stops instead of hammering /api/auth/login. Anything else
// (server still starting, network) exits 1 and is retried by compose.
try {
  process.stdout.write(await mint());
} catch (error) {
  console.error(`[demo] ${error.message}`);
  process.exit(error.status >= 400 && error.status < 500 ? 78 : 1);
}
