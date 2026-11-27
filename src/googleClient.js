const { google } = require('googleapis');
const { db } = require('./db');

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/tasks'
];

function getOAuthRecord() {
  return db.prepare('SELECT * FROM oauth_tokens WHERE id = ?').get('google') || null;
}

function saveOAuthConfig({ clientId, clientSecret }) {
  const existing = getOAuthRecord();
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`
      UPDATE oauth_tokens SET client_id = ?, client_secret = ?, updated_at = ? WHERE id = ?
    `).run(clientId.trim(), clientSecret.trim(), now, 'google');
  } else {
    db.prepare(`
      INSERT INTO oauth_tokens (id, client_id, client_secret, updated_at) VALUES (?, ?, ?, ?)
    `).run('google', clientId.trim(), clientSecret.trim(), now);
  }
}

function getCredentials() {
  const rec = getOAuthRecord();
  const clientId = (rec && rec.client_id) || process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = (rec && rec.client_secret) || process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback';
  return { clientId, clientSecret, redirectUri, rec };
}

function getOAuthClient() {
  const { clientId, clientSecret, redirectUri, rec } = getCredentials();
  if (!clientId || !clientSecret) return null;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  if (rec && (rec.access_token || rec.refresh_token)) {
    oauth2Client.setCredentials({
      access_token: rec.access_token || undefined,
      refresh_token: rec.refresh_token || undefined,
      expiry_date: rec.expiry_date || undefined
    });
    oauth2Client.on('tokens', (tokens) => {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE oauth_tokens
        SET access_token = COALESCE(?, access_token),
            refresh_token = COALESCE(?, refresh_token),
            expiry_date = COALESCE(?, expiry_date),
            updated_at = ?
        WHERE id = ?
      `).run(
        tokens.access_token || null,
        tokens.refresh_token || null,
        tokens.expiry_date || null,
        now,
        'google'
      );
    });
  }
  return oauth2Client;
}

function getGoogleAuthStatus() {
  const { clientId, clientSecret, redirectUri, rec } = getCredentials();
  const configured = Boolean(clientId && clientSecret);
  const connected = Boolean(configured && rec && (rec.access_token || rec.refresh_token));
  return {
    configured,
    connected,
    email: (rec && rec.email) || '',
    redirectUri,
    hasClientId: Boolean(clientId)
  };
}

function generateAuthUrl() {
  const client = getOAuthClient();
  if (!client) {
    throw new Error('Google OAuth Client ID and Client Secret are not configured yet.');
  }
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

async function handleOAuthCallback(code) {
  const client = getOAuthClient();
  if (!client) {
    throw new Error('Google OAuth Client ID and Client Secret are not configured.');
  }
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  let email = '';
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data.email || '';
  } catch (_) {
    // non-fatal if userinfo scope wasn't returned
  }

  const now = new Date().toISOString();
  const existing = getOAuthRecord();
  if (existing) {
    db.prepare(`
      UPDATE oauth_tokens
      SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expiry_date = ?, scope = ?, email = ?, updated_at = ?
      WHERE id = ?
    `).run(
      tokens.access_token || '',
      tokens.refresh_token || null,
      tokens.expiry_date || 0,
      tokens.scope || '',
      email || existing.email || '',
      now,
      'google'
    );
  } else {
    db.prepare(`
      INSERT INTO oauth_tokens (id, access_token, refresh_token, expiry_date, scope, email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'google',
      tokens.access_token || '',
      tokens.refresh_token || '',
      tokens.expiry_date || 0,
      tokens.scope || '',
      email,
      now
    );
  }

  if (email) {
    db.prepare('UPDATE connections SET account = ?, status = ?, last_used = ?').run(
      email,
      'connected',
      'Just now'
    );
  }

  return { email, connected: true };
}

function disconnectGoogle() {
  db.prepare(`
    UPDATE oauth_tokens
    SET access_token = '', refresh_token = '', expiry_date = 0, scope = '', updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), 'google');
}

async function scanGmailMessages(maxResults = 8) {
  const status = getGoogleAuthStatus();
  if (!status.connected) return { live: false, items: [] };

  const auth = getOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: 'in:inbox'
  });

  const messages = listRes.data.messages || [];
  const items = [];
  for (const m of messages.slice(0, maxResults)) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date']
    });
    const headers = msg.data.payload?.headers || [];
    const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    items.push({
      id: m.id,
      subject: getHeader('Subject') || '(No subject)',
      from: getHeader('From'),
      date: getHeader('Date'),
      snippet: msg.data.snippet || ''
    });
  }
  return { live: true, items };
}

async function scanCalendarEvents(maxResults = 10) {
  const status = getGoogleAuthStatus();
  if (!status.connected) return { live: false, items: [] };

  const auth = getOAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: twoWeeks.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults
  });
  return {
    live: true,
    items: (res.data.items || []).map((ev) => ({
      id: ev.id,
      summary: ev.summary || '(Untitled event)',
      start: ev.start?.dateTime || ev.start?.date || '',
      end: ev.end?.dateTime || ev.end?.date || '',
      description: ev.description || ''
    }))
  };
}

async function scanDriveFiles(maxResults = 8) {
  const status = getGoogleAuthStatus();
  if (!status.connected) return { live: false, items: [] };

  const auth = getOAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    pageSize: maxResults,
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
  });
  return {
    live: true,
    items: res.data.files || []
  };
}

async function listGoogleTasks(maxResults = 20) {
  const status = getGoogleAuthStatus();
  if (!status.connected) return { live: false, items: [] };

  const auth = getOAuthClient();
  const tasksApi = google.tasks({ version: 'v1', auth });
  const res = await tasksApi.tasks.list({
    tasklist: '@default',
    maxResults,
    showCompleted: true
  });
  return {
    live: true,
    items: res.data.items || []
  };
}

async function createGoogleTask({ title, notes, due }) {
  const status = getGoogleAuthStatus();
  if (!status.connected) return { live: false, task: null };

  const auth = getOAuthClient();
  const tasksApi = google.tasks({ version: 'v1', auth });
  const body = { title, notes: notes || '' };
  if (due) {
    const parsed = new Date(due);
    if (!Number.isNaN(parsed.getTime())) {
      body.due = parsed.toISOString();
    }
  }
  const res = await tasksApi.tasks.insert({
    tasklist: '@default',
    requestBody: body
  });
  return { live: true, task: res.data };
}

async function completeGoogleTask(googleTaskId, completed = true) {
  const status = getGoogleAuthStatus();
  if (!status.connected || !googleTaskId) return { live: false };

  const auth = getOAuthClient();
  const tasksApi = google.tasks({ version: 'v1', auth });
  await tasksApi.tasks.patch({
    tasklist: '@default',
    task: googleTaskId,
    requestBody: {
      status: completed ? 'completed' : 'needsAction'
    }
  });
  return { live: true };
}

async function executeApprovedAction(approval) {
  const status = getGoogleAuthStatus();
  const payload = JSON.parse(approval.action_payload_json || '{}');

  if (!status.connected) {
    return {
      live: false,
      detail: 'Executed in local Tether sandbox (connect Google OAuth in Connections for live Workspace writes).'
    };
  }

  const auth = getOAuthClient();

  if (approval.action_type === 'calendar_create') {
    const calendar = google.calendar({ version: 'v3', auth });
    const startIso = payload.start || new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const endIso = payload.end || new Date(new Date(startIso).getTime() + 30 * 60 * 1000).toISOString();
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: payload.summary || approval.title,
        description: payload.description || 'Created via Tether Safety Layer',
        start: { dateTime: startIso },
        end: { dateTime: endIso }
      }
    });
    return { live: true, detail: `Created Google Calendar event (${res.data.id}).` };
  }

  if (approval.action_type === 'gmail_draft') {
    const gmail = google.gmail({ version: 'v1', auth });
    const rawLines = [
      `To: ${payload.to || ''}`,
      `Subject: ${payload.subject || approval.title}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      payload.body || approval.message_preview || ''
    ];
    const raw = Buffer.from(rawLines.join('\r\n')).toString('base64url');
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } }
    });
    return { live: true, detail: `Created Gmail draft (${res.data.id}) safely without auto-sending.` };
  }

  if (approval.action_type === 'task_sync') {
    const res = await createGoogleTask({
      title: payload.title || approval.title,
      notes: payload.notes || '',
      due: payload.due || ''
    });
    return { live: true, detail: `Synced task to Google Tasks (${res.task?.id || 'ok'}).` };
  }

  return {
    live: true,
    detail: `Approved action (${approval.action_type}) recorded for Workspace execution.`
  };
}

module.exports = {
  saveOAuthConfig,
  getGoogleAuthStatus,
  generateAuthUrl,
  handleOAuthCallback,
  disconnectGoogle,
  scanGmailMessages,
  scanCalendarEvents,
  scanDriveFiles,
  listGoogleTasks,
  createGoogleTask,
  completeGoogleTask,
  executeApprovedAction
};
