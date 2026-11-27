const {
  db,
  getCounters,
  setCounters,
  setMeta,
  addAuditEntry
} = require('./db');
const googleClient = require('./googleClient');

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+rules/i,
  /forward\s+all\s+(drive\s+)?files/i,
  /permanently\s+delete/i,
  /empty\s+trash/i,
  /unknown-drop@/i,
  /external@collector/i,
  /export\s+address\s+book/i,
  /make\s+folders?\s+public/i
];

function detectSafetyThreat(text = '') {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return `Blocked by Tether Safety Guard: matched restricted pattern (${pattern.source}).`;
    }
  }
  return null;
}

function getPermissionPreset(appId) {
  const row = db.prepare('SELECT preset FROM permissions WHERE app_id = ?').get(appId);
  return row ? row.preset : 'balanced';
}

function isAppConnected(appId) {
  const row = db.prepare('SELECT status FROM connections WHERE id = ?').get(appId);
  return row && row.status === 'connected';
}

function inferPriority(text) {
  const lower = text.toLowerCase();
  if (/(urgent|asap|final|deadline|due\s+today|overdue|critical|exam|tax)/i.test(lower)) {
    return 'high';
  }
  if (/(review|prepare|sync|meeting|invoice|receipt|draft|follow\s*up)/i.test(lower)) {
    return 'medium';
  }
  return 'low';
}

function inferDueDate(text) {
  const now = new Date();
  const lower = text.toLowerCase();
  if (lower.includes('today')) {
    return now.toISOString().slice(0, 10) + 'T17:00:00';
  }
  if (lower.includes('tomorrow')) {
    const tmr = new Date(now.getTime() + 24 * 3600 * 1000);
    return tmr.toISOString().slice(0, 10) + 'T17:00:00';
  }
  if (lower.includes('next week')) {
    const nw = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    return nw.toISOString().slice(0, 10) + 'T12:00:00';
  }
  const monthMatch = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i);
  if (monthMatch) {
    const parsed = new Date(`${monthMatch[1]} ${monthMatch[2]}, ${now.getFullYear()} 17:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 19);
    }
  }
  return '';
}

function parseTextToTasks(inputText, sourceApp = 'manual') {
  const threat = detectSafetyThreat(inputText);
  if (threat) {
    const counters = getCounters();
    counters.blocked += 1;
    setCounters(counters);
    addAuditEntry({
      decision: 'Blocked',
      app: sourceApp === 'gmail' ? 'Gmail' : 'Tether Guard',
      action: `Blocked unsafe task extraction: "${inputText.slice(0, 72)}..."`,
      reason: threat
    });
    return { blocked: true, reason: threat, tasks: [] };
  }

  const lines = inputText
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);

  const actionable = lines.filter((line) =>
    /(todo|task|submit|send|review|prepare|schedule|pay|file|create|update|check|reply|draft|finish|complete|call|meet|due|deadline|by\s+\w+)/i.test(line)
  );

  const candidates = actionable.length > 0 ? actionable.slice(0, 5) : [inputText.trim()].filter(Boolean);
  const now = new Date().toISOString();
  const created = [];

  const insertStmt = db.prepare(`
    INSERT INTO tasks (id, title, description, source_app, source_ref, priority, status, due_at, auto_rule_id, suggested_reason, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const rawLine of candidates) {
    const cleanTitle = rawLine.replace(/^[-*•\d.)\s]+/, '').slice(0, 120);
    const id = `tsk-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const priority = inferPriority(cleanTitle);
    const dueAt = inferDueDate(cleanTitle);
    insertStmt.run(
      id,
      cleanTitle,
      `Extracted from ${sourceApp} input via Tether Smart Parser.`,
      sourceApp,
      `parse:${Date.now()}`,
      priority,
      'suggested',
      dueAt,
      'SMART-PARSE',
      'Detected actionable intent and priority from submitted text.',
      89,
      now,
      now
    );
    created.push(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  const counters = getCounters();
  counters.done += 1;
  setCounters(counters);
  addAuditEntry({
    decision: 'Allowed',
    app: 'Tether Smart Engine',
    action: `Extracted ${created.length} suggested task(s) from text`,
    reason: 'Safe read/parse operation completed automatically.'
  });

  return { blocked: false, tasks: created };
}

function upsertSuggestedTask({ title, description, sourceApp, sourceRef, priority, dueAt, ruleId, reason, confidence }) {
  const existing = db.prepare('SELECT id FROM tasks WHERE source_ref = ?').get(sourceRef);
  if (existing) return null;

  const id = `tsk-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (id, title, description, source_app, source_ref, priority, status, due_at, auto_rule_id, suggested_reason, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'suggested', ?, ?, ?, ?, ?, ?)
  `).run(id, title, description, sourceApp, sourceRef, priority, dueAt || '', ruleId || '', reason, confidence || 88, now, now);

  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

async function runSmartWorkspaceScan() {
  const authStatus = googleClient.getGoogleAuthStatus();
  const newlySuggested = [];
  let scannedSources = 0;

  if (authStatus.connected) {
    // 1. Live Gmail scan
    if (isAppConnected('gmail')) {
      scannedSources++;
      const gmailRes = await googleClient.scanGmailMessages(6);
      for (const msg of gmailRes.items) {
        const combined = `${msg.subject} ${msg.snippet}`;
        const threat = detectSafetyThreat(combined);
        if (threat) {
          const counters = getCounters();
          counters.blocked += 1;
          setCounters(counters);
          addAuditEntry({
            decision: 'Blocked',
            app: 'Gmail',
            action: `Blocked suspicious email "${msg.subject}"`,
            reason: threat
          });
          continue;
        }
        if (/(deadline|due|invoice|receipt|meeting|invite|action|review|submit|schedule|urgent)/i.test(combined)) {
          const added = upsertSuggestedTask({
            title: msg.subject.slice(0, 110),
            description: `From: ${msg.from}\n${msg.snippet}`,
            sourceApp: 'gmail',
            sourceRef: `gmail:${msg.id}`,
            priority: inferPriority(combined),
            dueAt: inferDueDate(combined),
            ruleId: 'LIVE-GMAIL',
            reason: `Matched actionable keywords in Gmail from ${msg.from || 'sender'}.`,
            confidence: 93
          });
          if (added) newlySuggested.push(added);
        }
      }
      addAuditEntry({
        decision: 'Allowed',
        app: 'Gmail',
        action: `Scanned ${gmailRes.items.length} recent inbox messages for tasks`,
        reason: 'Read-only Gmail scan ran automatically.'
      });
    }

    // 2. Live Calendar scan
    if (isAppConnected('calendar')) {
      scannedSources++;
      const calRes = await googleClient.scanCalendarEvents(6);
      for (const ev of calRes.items) {
        const added = upsertSuggestedTask({
          title: `Prepare for: ${ev.summary}`.slice(0, 110),
          description: ev.description || `Upcoming Google Calendar event at ${ev.start}`,
          sourceApp: 'calendar',
          sourceRef: `cal:${ev.id}`,
          priority: 'medium',
          dueAt: ev.start || '',
          ruleId: 'LIVE-CAL',
          reason: `Upcoming Calendar event scheduled for ${ev.start || 'soon'}.`,
          confidence: 86
        });
        if (added) newlySuggested.push(added);
      }
      addAuditEntry({
        decision: 'Allowed',
        app: 'Google Calendar',
        action: `Checked ${calRes.items.length} upcoming calendar events`,
        reason: 'Calendar free/busy & event read ran automatically.'
      });
    }

    // 3. Live Drive scan
    if (isAppConnected('drive')) {
      scannedSources++;
      const driveRes = await googleClient.scanDriveFiles(5);
      for (const f of driveRes.items) {
        if (/(draft|rubric|proposal|invoice|tax|notes|plan|review)/i.test(f.name)) {
          const added = upsertSuggestedTask({
            title: `Review Drive file: ${f.name}`.slice(0, 110),
            description: `Recently modified in Google Drive (${f.modifiedTime || 'recently'}).`,
            sourceApp: 'drive',
            sourceRef: `drive:${f.id}`,
            priority: 'low',
            dueAt: '',
            ruleId: 'LIVE-DRIVE',
            reason: 'Recently updated Drive document matched review rule.',
            confidence: 82
          });
          if (added) newlySuggested.push(added);
        }
      }
      addAuditEntry({
        decision: 'Allowed',
        app: 'Google Drive',
        action: `Scanned ${driveRes.items.length} recent Drive files`,
        reason: 'Read-only Drive metadata scan ran automatically.'
      });
    }

    // 4. Live Google Tasks import
    if (isAppConnected('tasks')) {
      scannedSources++;
      const tasksRes = await googleClient.listGoogleTasks(15);
      for (const gt of tasksRes.items) {
        if (gt.status === 'completed') continue;
        const added = upsertSuggestedTask({
          title: (gt.title || 'Untitled Google Task').slice(0, 110),
          description: gt.notes || 'Imported from Google Tasks @default list.',
          sourceApp: 'tasks',
          sourceRef: `gtask:${gt.id}`,
          priority: 'medium',
          dueAt: gt.due || '',
          ruleId: 'SYNC-TASKS',
          reason: 'Synced from your Google Tasks list.',
          confidence: 98
        });
        if (added) newlySuggested.push(added);
      }
    }
  } else {
    // Local / Sandbox Smart Suggestions when OAuth isn't connected yet
    const sandboxCandidates = [
      {
        title: 'Reply to Advisor Email on Thesis Milestone Dates',
        description: 'Detected open question in Gmail thread regarding December milestone review.',
        sourceApp: 'gmail',
        sourceRef: 'sandbox:advisor-milestone',
        priority: 'high',
        dueAt: inferDueDate('tomorrow'),
        ruleId: 'RULE-03',
        reason: 'Meeting/deadline signal detected during smart workspace scan.',
        confidence: 91
      },
      {
        title: 'Organize Q4 Lecture Notes & Slides in /School/CS-301',
        description: '3 unfiled documents detected in Drive root folder.',
        sourceApp: 'drive',
        sourceRef: 'sandbox:drive-q4-notes',
        priority: 'low',
        dueAt: inferDueDate('next week'),
        ruleId: 'RULE-02',
        reason: 'Drive organization rule suggested filing recent uploads.',
        confidence: 84
      }
    ];

    for (const c of sandboxCandidates) {
      if (isAppConnected(c.sourceApp)) {
        scannedSources++;
        const added = upsertSuggestedTask(c);
        if (added) newlySuggested.push(added);
      }
    }

    addAuditEntry({
      decision: 'Allowed',
      app: 'Tether Smart Engine',
      action: `Completed workspace scan (${newlySuggested.length} new suggestion${newlySuggested.length === 1 ? '' : 's'})`,
      reason: 'Ran local smart task rules. Connect Google OAuth in Connections for live Gmail/Calendar/Drive/Tasks scanning.'
    });
  }

  const counters = getCounters();
  counters.done += Math.max(1, scannedSources);
  setCounters(counters);
  setMeta('last_scan_at', new Date().toISOString());

  return {
    live: authStatus.connected,
    newlySuggested,
    scannedSources
  };
}

async function acceptSuggestedTask(taskId, options = {}) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return null;

  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('todo', now, taskId);

  const counters = getCounters();
  let queuedApproval = null;
  let googleSynced = false;

  if (options.syncToGoogle && isAppConnected('tasks')) {
    const tasksPreset = getPermissionPreset('tasks');
    const authStatus = googleClient.getGoogleAuthStatus();
    if (tasksPreset === 'handoff' && authStatus.connected) {
      const res = await googleClient.createGoogleTask({
        title: task.title,
        notes: task.description,
        due: task.due_at
      });
      if (res.task?.id) {
        db.prepare('UPDATE tasks SET google_task_id = ? WHERE id = ?').run(res.task.id, taskId);
        googleSynced = true;
      }
      counters.done += 1;
      addAuditEntry({
        decision: 'Allowed',
        app: 'Google Tasks',
        action: `Synced task "${task.title}" to Google Tasks`,
        reason: 'Google Tasks permission is set to Hands-off (auto-sync enabled).'
      });
    } else if (tasksPreset !== 'handoff') {
      const aprId = `apr-${Date.now()}`;
      db.prepare(`
        INSERT INTO approvals (id, app, app_name, title, why_paused, details_json, message_preview, action_type, action_payload_json, status, task_id, timestamp, created_at)
        VALUES (?, 'tasks', 'Google Tasks', ?, ?, ?, '', 'task_sync', ?, 'pending', ?, 'Just now', ?)
      `).run(
        aprId,
        `Sync task '${task.title}' to Google Tasks`,
        `${tasksPreset === 'cautious' ? 'Cautious' : 'Balanced'} mode pauses external Google Tasks writes for confirmation.`,
        JSON.stringify([
          { label: 'Task Title', value: task.title },
          { label: 'Priority', value: task.priority.toUpperCase() },
          { label: 'Due', value: task.due_at || 'No due date' }
        ]),
        JSON.stringify({ title: task.title, notes: task.description, due: task.due_at }),
        taskId,
        now
      );
      counters.waiting += 1;
      queuedApproval = aprId;
    }
  }

  if (options.queueCalendar && isAppConnected('calendar')) {
    const calPreset = getPermissionPreset('calendar');
    const aprId = `apr-${Date.now() + 1}`;
    db.prepare(`
      INSERT INTO approvals (id, app, app_name, title, why_paused, details_json, message_preview, action_type, action_payload_json, status, task_id, timestamp, created_at)
      VALUES (?, 'calendar', 'Google Calendar', ?, ?, ?, '', 'calendar_create', ?, 'pending', ?, 'Just now', ?)
    `).run(
      aprId,
      `Schedule time block for '${task.title}'`,
      `${calPreset === 'cautious' ? 'Cautious' : 'Balanced'} mode pauses new calendar events for your confirmation.`,
      JSON.stringify([
        { label: 'Event Title', value: task.title },
        { label: 'Suggested Time', value: task.due_at || 'Next open 30-min slot' }
      ]),
      JSON.stringify({
        summary: task.title,
        description: task.description,
        start: task.due_at ? new Date(task.due_at).toISOString() : new Date(Date.now() + 24 * 3600 * 1000).toISOString()
      }),
      taskId,
      now
    );
    counters.waiting += 1;
    queuedApproval = aprId;
  }

  counters.done += 1;
  setCounters(counters);
  addAuditEntry({
    decision: 'Allowed',
    app: 'Tether Tasks',
    action: `Accepted suggested task "${task.title}"`,
    reason: 'Task saved to your active Tether Task Board.'
  });

  return {
    task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId),
    queuedApproval,
    googleSynced
  };
}

module.exports = {
  detectSafetyThreat,
  parseTextToTasks,
  runSmartWorkspaceScan,
  acceptSuggestedTask
};
