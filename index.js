// index.js
import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import axios from 'axios';
import { WebClient } from '@slack/web-api';

const {
  SLACK_TOKEN,
  SLACK_CHANNEL_ID,
  POLL_INTERVAL_MS = 15000,
  BACKFILL_SECONDS = 300, // ao iniciar, busca últimos N segundos
  JIRA_BASE,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY = 'TDS',
  JIRA_ISSUE_TYPE = 'Incident'
} = process.env;

if (!SLACK_TOKEN || !SLACK_CHANNEL_ID) throw new Error('Faltam SLACK_TOKEN/SLACK_CHANNEL_ID');
if (!JIRA_BASE || !JIRA_EMAIL || !JIRA_API_TOKEN) throw new Error('Faltam credenciais do Jira');

const slack = new WebClient(SLACK_TOKEN);

// ---------------- Persistência de estado ----------------
const STATE_FILE = process.env.STATE_FILE || './state.json';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}
let state = loadState();
if (!state[SLACK_CHANNEL_ID]) {
  state[SLACK_CHANNEL_ID] = { lastTs: (Date.now() / 1000 - Number(BACKFILL_SECONDS)).toString() };
  saveState(state);
}

// ---------------- Utils para extrair texto do Slack ----------------
function extractText(msg) {
  if (msg.text) return msg.text;
  if (Array.isArray(msg.blocks)) {
    const out = [];
    for (const b of msg.blocks) {
      if (b.type === 'section' && b.text?.text) out.push(b.text.text);
      if (b.type === 'rich_text' && Array.isArray(b.elements)) {
        for (const el of b.elements) {
          if (el.type === 'rich_text_section' && Array.isArray(el.elements)) {
            const parts = [];
            for (const e of el.elements) {
              if (e.type === 'text' && e.text) parts.push(e.text);
              else if (e.type === 'link') parts.push(e.text || e.url || '');
              else if (e.type === 'emoji' && e.name) parts.push(shortcodeToUnicode(e.name) || `:${e.name}:`);
              else if (e.type === 'user' && e.user_id) parts.push(`@${e.user_id}`);
              else if (e.type === 'channel' && e.channel_id) parts.push(`#${e.channel_id}`);
              else if (typeof e.text === 'string') parts.push(e.text);
            }
            out.push(parts.join(''));
          }
        }
      }
    }
    return out.join('\n').trim();
  }
  if (Array.isArray(msg.attachments)) {
    return msg.attachments.map(a => a.text || a.fallback || '').join('\n').trim();
  }
  return '';
}

// Converte texto Slack (<url|texto>) para ADF (Jira)
function toAdfFromSlackText(plainText) {
  const text = String(plainText || '');
  const lines = text.split('\n');
  const content = lines.map(line => {
    const parts = [];
    const linkRe = /<([^|>]+)\|([^>]+)>/g; // <url|text>
    let lastIndex = 0;
    let m;
    while ((m = linkRe.exec(line)) !== null) {
      if (m.index > lastIndex) {
        parts.push({ type: 'text', text: replaceSlackEmojiShortcodes(line.slice(lastIndex, m.index)) });
      }
      const href = m[1];
      const textLabel = m[2];
      parts.push({ type: 'text', text: replaceSlackEmojiShortcodes(textLabel), marks: [{ type: 'link', attrs: { href } }] });
      lastIndex = linkRe.lastIndex;
    }
    if (lastIndex < line.length) {
      parts.push({ type: 'text', text: replaceSlackEmojiShortcodes(line.slice(lastIndex)) });
    }
    return { type: 'paragraph', content: parts.length ? parts : [] };
  });
  return { type: 'doc', version: 1, content };
}

function sanitizeSummary(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ---------------- Emoji helpers ----------------
const SLACK_EMOJI_MAP = {
  red_circle: '🔴',
  link: '🔗',
  mag: '🔎',
  alert: '🚨',
  warning: '⚠️',
  info: 'ℹ️',
  white_check_mark: '✅',
  heavy_check_mark: '✔️'
};
function shortcodeToUnicode(name) {
  return SLACK_EMOJI_MAP[name];
}
function replaceSlackEmojiShortcodes(text) {
  return String(text || '').replace(/:([a-z0-9_+-]+):/gi, (m, p1) => shortcodeToUnicode(p1) || m);
}

// ---------------- Resumo / descrição ----------------
function extractSummaryFromText(fullText) {
  const lines = String(fullText || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  const stripSlackLinks = (line) => line.replace(/<([^|>]+)\|([^>]+)>/g, '$2');

  for (const raw of lines) {
    const text = stripSlackLinks(raw);
    const idx = text.toLowerCase().indexOf('triggered:');
    if (idx >= 0) return sanitizeSummary(text.slice(idx));
  }
  return sanitizeSummary(stripSlackLinks(lines[0] || ''));
}

function extractSummaryFromMessage(msg) {
  if (Array.isArray(msg.attachments)) {
    for (const a of msg.attachments) {
      if (a?.title && /triggered:/i.test(a.title)) return sanitizeSummary(a.title);
      if (a?.fallback && /triggered:/i.test(a.fallback)) return sanitizeSummary(a.fallback);
    }
    const firstTitle = msg.attachments.find(a => a?.title)?.title;
    if (firstTitle) return sanitizeSummary(firstTitle);
  }
  const text = extractText(msg);
  return extractSummaryFromText(text);
}

function extractImageUrlsFromMessage(msg) {
  const images = [];
  if (Array.isArray(msg.files)) {
    for (const f of msg.files) {
      if (String(f.mimetype || '').startsWith('image/') && f.url_private) {
        images.push({ url: f.url_private, filename: f.name || `${f.id}.png`, private: true });
      }
    }
  }
  if (Array.isArray(msg.attachments)) {
    for (const a of msg.attachments) {
      if (a.image_url) images.push({ url: a.image_url, filename: 'attachment.png', private: false });
    }
  }
  if (Array.isArray(msg.blocks)) {
    for (const b of msg.blocks) {
      if (b.type === 'image' && b.image_url) {
        images.push({ url: b.image_url, filename: b.alt || 'image.png', private: false });
      }
      if (b.type === 'context' && Array.isArray(b.elements)) {
        for (const el of b.elements) {
          if (el.type === 'image' && el.image_url) {
            images.push({ url: el.image_url, filename: el.alt || 'image.png', private: false });
          }
        }
      }
    }
  }
  return images;
}

// Monta ADF com texto e imagens externas
function buildDescriptionAdf({ permalink, text, message }) {
  const images = extractImageUrlsFromMessage(message);
  const imageNodes = images.slice(0, 5).map(img => ({
    type: 'mediaSingle',
    attrs: { layout: 'center' },
    content: [
      {
        type: 'media',
        attrs: { type: 'external', url: img.url }
      }
    ]
  }));

  if (Array.isArray(message?.attachments) && message.attachments.length > 0) {
    const a = message.attachments[0];
    const content = [];
    if (a?.title) {
      if (a.title_link) {
        content.push({
          type: 'paragraph',
          content: [{ type: 'text', text: a.title, marks: [{ type: 'link', attrs: { href: a.title_link } }] }]
        });
      } else {
        content.push({ type: 'paragraph', content: [{ type: 'text', text: a.title }] });
      }
    } else if (a?.fallback) {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: a.fallback }] });
    }

    if (a?.text) {
      const body = toAdfFromSlackText(a.text);
      if (Array.isArray(body.content)) content.push(...body.content);
    }

    if (Array.isArray(a?.fields)) {
      for (const f of a.fields) {
        if (f.title) content.push({ type: 'paragraph', content: [{ type: 'text', text: f.title }] });
        if (f.value) {
          const vdoc = toAdfFromSlackText(String(f.value));
          if (Array.isArray(vdoc.content)) content.push(...vdoc.content);
        }
      }
    }

    return { type: 'doc', version: 1, content: [...content, ...imageNodes] };
  }

  const bodyDoc = toAdfFromSlackText(text);
  return { type: 'doc', version: 1, content: [...(bodyDoc.content || []), ...imageNodes] };
}

function buildLinearTextFromMessage(msg) {
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    const a = msg.attachments[0];
    const parts = [];
    if (a?.title) parts.push(a.title);
    else if (a?.fallback) parts.push(a.fallback);
    if (a?.text) parts.push(a.text);
    if (Array.isArray(a.fields)) {
      for (const f of a.fields) {
        if (f.title) parts.push(f.title);
        if (f.value) parts.push(f.value);
      }
    }
    return parts.join('\n');
  }
  return extractText(msg);
}

// ---------------- Jira helpers ----------------
const jiraHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };

function normalizeString(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

async function jiraGet(path) {
  const url = `${JIRA_BASE}${path}`;
  const { data } = await axios.get(url, {
    auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
    headers: jiraHeaders
  });
  return data;
}

let jiraMetaCache = {
  priorities: null,      // [{id, name}]
  assuntoOptions: null   // [{id, value}]
};

async function fetchGlobalPriorities() {
  const list = await jiraGet('/rest/api/3/priority');
  return Array.isArray(list) ? list.map(p => ({ id: p.id, name: p.name })) : [];
}

async function fetchCreateMetaFields() {
  const meta = await jiraGet(
    `/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(
      JIRA_PROJECT_KEY
    )}&issuetypeNames=${encodeURIComponent(JIRA_ISSUE_TYPE)}&expand=projects.issuetypes.fields`
  );
  const project = meta.projects?.[0];
  const issueType = project?.issuetypes?.[0];
  const fields = issueType?.fields || {};
  return fields;
}

async function fetchProjectPriorities() {
  try {
    const fields = await fetchCreateMetaFields();
    const pr = fields.priority;
    if (Array.isArray(pr?.allowedValues)) {
      return pr.allowedValues.map(v => ({ id: v.id, name: v.name }));
    }
  } catch {}
  return await fetchGlobalPriorities();
}

async function fetchAssuntoOptions() {
  try {
    const fields = await fetchCreateMetaFields();
    const assuntoField = fields['customfield_13712'];
    const options = Array.isArray(assuntoField?.allowedValues)
      ? assuntoField.allowedValues.map(o => ({ id: o.id, value: o.value }))
      : [];
    return options;
  } catch {
    return [];
  }
}

async function ensureJiraMetaLoaded() {
  if (!jiraMetaCache.priorities) {
    jiraMetaCache.priorities = await fetchProjectPriorities();
  }
  if (!jiraMetaCache.assuntoOptions) {
    jiraMetaCache.assuntoOptions = await fetchAssuntoOptions();
  }
}

function resolvePriorityId(inputPriority) {
  const normalizedInput = normalizeString(inputPriority);
  const list = jiraMetaCache.priorities || [];

  let found = list.find(p => normalizeString(p.name) === normalizedInput);
  if (found) return found.id;

  const synonyms = {
    alta: ['alta', 'high'],
    media: ['media', 'média', 'medium'],
    baixa: ['baixa', 'low'],
    'mais alta': ['mais alta', 'highest'],
    'mais baixa': ['mais baixa', 'lowest']
  };
  for (const [canon, words] of Object.entries(synonyms)) {
    if (words.includes(normalizedInput)) {
      found = list.find(p => normalizeString(p.name) === canon);
      if (found) return found.id;
    }
  }
  found = list.find(p => normalizeString(p.name).includes(normalizedInput));
  return found?.id || null;
}

function resolveAssuntoOptionId(label) {
  const normalizedTarget = normalizeString(label);
  const options = jiraMetaCache.assuntoOptions || [];
  const match = options.find(o => normalizeString(o.value) === normalizedTarget);
  return match?.id || null;
}

async function createJiraIssue({ summary, description, descriptionAdf, priority = 'Medium' }) {
  await ensureJiraMetaLoaded();

  const priorityIdEnv = process.env.JIRA_PRIORITY_ID && String(process.env.JIRA_PRIORITY_ID).trim();
  const priorityId = priorityIdEnv || resolvePriorityId(priority);
  if (!priorityId) {
    throw new Error(
      `Prioridade inválida: "${priority}". Disponíveis: ${
        (jiraMetaCache.priorities || []).map(p => p.name).join(', ') || 'nenhuma'
      }`
    );
  }

  const assuntoLabel = process.env.JIRA_ASSUNTO_DEFAULT || 'Plantão - API / Transportadoras';
  const assuntoIdEnv = process.env.JIRA_ASSUNTO_ID && String(process.env.JIRA_ASSUNTO_ID).trim();
  const assuntoId = assuntoIdEnv || resolveAssuntoOptionId(assuntoLabel);
  if (!assuntoId) {
    throw new Error(
      `Assunto inválido: "${assuntoLabel}" para customfield_13712. Disponíveis: ${
        (jiraMetaCache.assuntoOptions || []).map(o => o.value).join(', ') || 'nenhum'
      }`
    );
  }

  const url = `${JIRA_BASE}/rest/api/3/issue`;
  const descriptionDoc = descriptionAdf || toAdfFromSlackText(description);

  const baseFields = {
    project: { key: JIRA_PROJECT_KEY },
    issuetype: { name: JIRA_ISSUE_TYPE },
    summary: sanitizeSummary(summary),
    description: descriptionDoc,
    customfield_13712: { id: assuntoId }
  };

  const priorityNameFromCache = (jiraMetaCache.priorities || []).find(p => p.id === priorityId)?.name;

  try {
    const payload = { fields: { ...baseFields, priority: { id: priorityId } } };
    const { data } = await axios.post(url, payload, {
      auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
    });
    return data.key;
  } catch (e) {
    const msg = e?.response?.data?.errors?.priority || e?.response?.data?.errorMessages?.[0] || '';
    const looksLikeInvalidPriority = /inválid|invalid/i.test(String(msg));
    if (!looksLikeInvalidPriority) throw e;

    const priorityName = priorityNameFromCache || priority;
    const payloadByName = { fields: { ...baseFields, priority: { name: priorityName } } };
    const { data } = await axios.post(url, payloadByName, {
      auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
    });
    return data.key;
  }
}

// ---------------- Poll do Slack ----------------
let lastSlackMessage = null;

async function pollOnce() {
  const oldest = state[SLACK_CHANNEL_ID].lastTs || '0';
  const resp = await slack.conversations.history({
    channel: SLACK_CHANNEL_ID,
    oldest,
    inclusive: false,
    limit: 200
  });

  if (!resp.ok || !resp.messages?.length) return;

  const messages = resp.messages
    .filter(m => m.ts > oldest)
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  for (const m of messages) {
    lastSlackMessage = m;
    state[SLACK_CHANNEL_ID].lastTs = m.ts;
    const text = buildLinearTextFromMessage(m);
    if (!text) continue;

    const lowered = text.toLowerCase();
    if (lowered.includes('recovered')) continue;
    if (!(/\btriggered\b/i.test(text) || /Triggered:/.test(text))) continue;

    const summary = extractSummaryFromMessage(m);
    const priority = 'High';

    let permalink = '';
    try {
      const pl = await slack.chat.getPermalink({ channel: SLACK_CHANNEL_ID, message_ts: m.ts });
      if (pl.ok) permalink = pl.permalink;
    } catch {}

    const description = text;
    const descriptionAdf = buildDescriptionAdf({ permalink, text, message: m });

    try {
      const issueKey = await createJiraIssue({ summary, description, descriptionAdf, priority });
      console.log(`✅ Criada issue ${issueKey} (prio ${priority})`);
    } catch (e) {
      console.error('❌ Erro ao criar issue:', e.response?.data || e.message);
    }
  }

  saveState(state);
}

// Inicia o polling
setInterval(() => {
  pollOnce().catch(err => console.error('poll error:', err.message));
}, Number(POLL_INTERVAL_MS));

// ---------------- HTTP server (health/debug) ----------------
const app = express();
app.get('/', (_req, res) => res.send('ok'));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/meta', async (_req, res) => {
  try {
    await ensureJiraMetaLoaded();
    res.json({
      priorities: jiraMetaCache.priorities,
      assuntoOptions: jiraMetaCache.assuntoOptions
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});
app.get('/debug/last', (_req, res) => {
  if (!lastSlackMessage) return res.status(404).json({ error: 'Ainda não há mensagem processada.' });
  res.json(lastSlackMessage);
});

// Porta para Render (PORT) ou 3000 local
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
console.log(`⏱️ Iniciando poll a cada ${POLL_INTERVAL_MS}ms…`);
