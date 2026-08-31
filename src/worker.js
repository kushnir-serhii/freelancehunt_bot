/**
 * Freelancehunt -> Telegram
 *
 * Опитує /v2/projects, фільтрує за ключовими словами й бюджетом,
 * шле нові проєкти в Telegram. Стан (останній побачений id) — у KV.
 *
 * Локально:  npx wrangler dev
 *            curl "http://localhost:8787/run?key=dev"
 * Прод:      npx wrangler deploy
 */

// ─────────────────────────────────────────────
// НАЛАШТУВАННЯ — редагуй тут
// ─────────────────────────────────────────────
const CONFIG = {
  // Проєкт проходить, якщо назва або опис містить хоч один з цих фрагментів.
  // Пиши основи слів без закінчень: "верстк" зловить "верстка", "верстку", "верстки".
  stems: [
    'лендінг', 'лендинг', 'landing',
    'верстк', 'вёрстк', 'верста',
    'односторінк', 'одностран', 'one page', 'onepage',
    'сайт-візитк', 'сайт-визитк',
    'адаптив',
    'html', 'css', 'tailwind', 'bootstrap',
    'react', 'next.js', 'nextjs', 'astro', 'vue',
    'javascript', 'typescript',
    'frontend', 'front-end', 'фронтенд',
    'веб-розробк', 'веб-разработ', 'веб розробк',
    'сайт під ключ', 'сайт под ключ',
    'gsap', 'анімац', 'анимац',
    'supabase', 'strapi', 'sanity', 'node.js', 'nodejs',
  ],

  // Якщо трапиться хоч один — проєкт відкидається (навіть якщо збігся stem вище).
  exclude: [
    '1с', '1c-бітрикс', 'битрикс', 'бітрикс',
    'opencart', 'joomla', 'drupal', 'magento',
    'копірайт', 'копирайт', 'рерайт',
  ],

  // Мінімальний бюджет у гривнях. 0 = без обмеження.
  minBudgetUAH: 0,

  // Пропускати проєкти без вказаного бюджету?
  includeNoBudget: true,

  // Скільки повідомлень максимум за один запуск (захист від флуду).
  maxPerRun: 8,

  // Курс для перерахунку бюджетів у USD -> UAH при перевірці minBudgetUAH.
  usdToUah: 44.5,
};

const API = 'https://api.freelancehunt.com/v2/projects';
const KV_LAST_ID = 'last_seen_id';

// ─────────────────────────────────────────────
// Точки входу
// ─────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    // Решта роутів під ключем, щоб чужий не смикав.
    if (env.TRIGGER_KEY && key !== env.TRIGGER_KEY) {
      return json({ error: 'bad key' }, 401);
    }

    if (url.pathname === '/run') {
      const result = await poll(env);
      return json(result);
    }

    // Показує сирий JSON першого проєкту — щоб звірити назви полів,
    // якщо API колись зміниться.
    if (url.pathname === '/debug') {
      const res = await apiGet(env, 1);
      return json({ status: res.status, first: res.body?.data?.[0] ?? null });
    }

    // Забути стан: наступний запуск знову візьме точку відліку.
    if (url.pathname === '/reset') {
      await env.STATE.delete(KV_LAST_ID);
      return json({ ok: true, message: 'стан очищено' });
    }

    return json({ routes: ['/run', '/debug', '/reset', '/health'] }, 404);
  },
};

// ─────────────────────────────────────────────
// Основна логіка
// ─────────────────────────────────────────────
async function poll(env) {
  const res = await apiGet(env, 1);

  if (res.status === 429) {
    return { ok: false, reason: 'rate limited', retryAfter: res.retryAfter };
  }
  if (res.status !== 200 || !Array.isArray(res.body?.data)) {
    return { ok: false, reason: `HTTP ${res.status}`, body: res.body };
  }

  const projects = res.body.data.map(normalize).sort((a, b) => b.id - a.id);
  if (projects.length === 0) return { ok: true, checked: 0, sent: 0 };

  const stored = await env.STATE.get(KV_LAST_ID);
  const lastSeen = stored ? Number(stored) : null;
  const newestId = projects[0].id;

  // Перший запуск: не спамимо історією, лише ставимо точку відліку.
  if (lastSeen === null) {
    await env.STATE.put(KV_LAST_ID, String(newestId));
    await sendTelegram(
      env,
      '🤖 <b>Бот запущено.</b>\nСтежу за новими проєктами на Freelancehunt.',
    );
    return { ok: true, firstRun: true, anchor: newestId };
  }

  const fresh = projects.filter((p) => p.id > lastSeen);
  const matched = fresh.filter(matches).slice(0, CONFIG.maxPerRun);

  for (const p of matched) {
    await sendTelegram(env, render(p));
  }

  if (fresh.length > 0) {
    await env.STATE.put(KV_LAST_ID, String(newestId));
  }

  return {
    ok: true,
    checked: projects.length,
    fresh: fresh.length,
    sent: matched.length,
    rateRemaining: res.rateRemaining,
  };
}

async function apiGet(env, page) {
  const res = await fetch(`${API}?page[number]=${page}`, {
    headers: {
      Authorization: `Bearer ${env.FH_TOKEN}`,
      Accept: 'application/json',
      'Accept-Language': 'uk',
    },
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* не JSON — лишаємо null */
  }

  return {
    status: res.status,
    body,
    rateRemaining: res.headers.get('X-Ratelimit-Remaining'),
    retryAfter: res.headers.get('Retry-After'),
  };
}

// Freelancehunt повертає JSON:API-подібну структуру, але поля з часом
// їздять між кореневим об'єктом і attributes — читаємо обережно з обох.
function normalize(raw) {
  const a = raw.attributes ?? raw;
  const skills = Array.isArray(a.skills)
    ? a.skills.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean)
    : [];

  return {
    id: Number(raw.id ?? a.id),
    name: a.name ?? '',
    description: a.description ?? a.description_html ?? '',
    skills,
    budget: a.budget ?? null,
    bidCount: a.bid_count ?? null,
    employer: a.employer?.login ?? a.employer?.first_name ?? null,
    safeType: a.safe_type ?? null,
    url:
      raw.links?.self?.web ??
      a.links?.self?.web ??
      `https://freelancehunt.com/project/${raw.id ?? a.id}`,
  };
}

function matches(p) {
  const haystack = `${p.name} ${p.description} ${p.skills.join(' ')}`
    .toLowerCase()
    .replace(/ё/g, 'е');

  if (CONFIG.exclude.some((s) => haystack.includes(s))) return false;
  if (!CONFIG.stems.some((s) => haystack.includes(s))) return false;

  const uah = budgetInUah(p.budget);
  if (uah === null) return CONFIG.includeNoBudget;
  return uah >= CONFIG.minBudgetUAH;
}

function budgetInUah(budget) {
  if (!budget?.amount) return null;
  const amount = Number(budget.amount);
  if (!Number.isFinite(amount)) return null;
  return budget.currency === 'USD' ? amount * CONFIG.usdToUah : amount;
}

function render(p) {
  const lines = [`🟢 <b>${esc(p.name)}</b>`];

  const money = p.budget?.amount
    ? `${Number(p.budget.amount).toLocaleString('uk-UA')} ${esc(p.budget.currency ?? '')}`
    : 'бюджет не вказано';
  const bids = p.bidCount === null ? '' : ` · ставок: ${p.bidCount}`;
  lines.push(`💰 ${money}${bids}`);

  if (p.skills.length) lines.push(`🏷 ${esc(p.skills.slice(0, 4).join(', '))}`);

  const snippet = stripHtml(p.description).slice(0, 300);
  if (snippet) lines.push('', esc(snippet) + (snippet.length >= 300 ? '…' : ''));

  lines.push('', p.url);
  return lines.join('\n');
}

async function sendTelegram(env, text) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    },
  );
  if (!res.ok) console.error('telegram', res.status, await res.text());
}

// ─────────────────────────────────────────────
// Дрібниці
// ─────────────────────────────────────────────
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const stripHtml = (s) =>
  String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
