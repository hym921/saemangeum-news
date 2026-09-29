// 새만금 현대차그룹 AI 데이터센터 뉴스 모니터 — 의존성 없는 Node 서버
// 실행: node server.js  →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const POLL_MS = 3 * 60 * 1000; // 3분마다 새 기사 수집

const QUERIES = [
  '새만금 현대차 AI 데이터센터',
  '새만금 현대차그룹 데이터센터',
  '새만금 산업단지 현대자동차 AI',
  '새만금 AI 데이터센터',
];

// 관련성 필터: 제목에 새만금 + (데이터센터|AI) + (현대) 포함
const isRelevant = (t) =>
  /새만금/.test(t) && /(데이터\s?센터|AI|인공지능)/i.test(t) && /(현대|HD현대|기아)/.test(t);

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : '';
};

async function fetchQuery(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${res.status} ${q}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const it = m[1];
    let title = tag(it, 'title');
    const source = tag(it, 'source');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return {
      title,
      link: tag(it, 'link'),
      source: source || '출처 미상',
      pubDate: new Date(tag(it, 'pubDate')).toISOString(),
    };
  });
}

async function fetchBing(q) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setmkt=ko-KR&count=50`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${res.status} bing ${q}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const it = m[1];
    const raw = tag(it, 'link');
    const real = new URL(raw).searchParams.get('url'); // 원문 주소가 그대로 들어 있음
    return {
      title: tag(it, 'title'),
      link: real || raw,
      direct: !!real,
      source: tag(it, 'News:Source').replace(/ on MSN$/, '') || '출처 미상',
      pubDate: new Date(tag(it, 'pubDate')).toISOString(),
      snippet: tag(it, 'description'),
      image: tag(it, 'News:Image').replace(/^http:/, 'https:'),
    };
  });
}

// 네이버 뉴스 검색(키 불필요)에서 제목으로 원문 주소·요약을 찾는다
async function fetchNaver(q) {
  const url = `https://search.naver.com/search.naver?where=news&sort=1&query=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9' } });
  if (!res.ok) throw new Error(`${res.status} naver`);
  const html = await res.text();
  const strip = (h) => decode(h.replace(/<[^>]+>/g, '')).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return [...html.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*data-heatmap-target="\.tit"[^>]*>([\s\S]*?)<\/a>(?:\s*<a[^>]*data-heatmap-target="\.body"[^>]*>([\s\S]*?)<\/a>)?/g)]
    .map((m) => ({ link: decode(m[1]), title: strip(m[2]), snippet: m[3] ? strip(m[3]) : '' }));
}

let articles = []; // 최신순
let lastUpdated = null;
const seen = new Set();
const known = new Map(); // link → article (미리보기 요청 검증용)
const clients = new Set();

const keyOf = (a) => a.title.replace(/[\s\W]+/g, '').slice(0, 40);

async function poll() {
  const results = await Promise.allSettled([...[...QUERIES, '현대차 새만금 데이터센터', '새만금 AI 데이터센터 착공', '새만금 현대차 8.9조'].map(fetchBing), ...QUERIES.map(fetchQuery)]);
  const fresh = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') { console.warn('수집 실패:', r.reason.message); continue; }
    for (const a of r.value) {
      const k = keyOf(a);
      if (!isRelevant(a.title) || seen.has(k)) continue;
      seen.add(k);
      known.set(a.link, a);
      fresh.push(a);
    }
  }
  // 구글 링크 기사는 서버에서 원문 주소를 못 풀 수 있어, 제목으로 Bing을 검색해 원문 주소를 찾아 붙인다
  await Promise.all(fresh.filter((x) => !x.direct).map(async (a) => {
    try {
      const win = keyOf(a).slice(3, 15); // 앞머리 [태그]·말줄임 차이를 피해 중간 구간으로 비교
      const same = (b) => keyOf(b).includes(win);
      let hit = (await fetchBing(a.title.slice(0, 60))).find(same);
      if (!hit) hit = (await fetchNaver(a.title.replace(/^[[^]]*]s*/, '').slice(0, 40))).find(same);
      if (!hit) return;
      known.delete(a.link);
      Object.assign(a, { link: hit.link, direct: true, snippet: hit.snippet, image: hit.image });
      known.set(a.link, a);
    } catch { /* 실패해도 구글 링크로 계속 표시 */ }
  }));
  lastUpdated = new Date().toISOString();
  if (fresh.length) {
    articles = [...fresh, ...articles].sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    console.log(`[${lastUpdated}] 새 기사 ${fresh.length}건 (총 ${articles.length})`);
  }
  const first = fresh.length && articles.length === fresh.length;
  const payload = JSON.stringify({ fresh: first ? [] : fresh, lastUpdated });
  for (const c of clients) c.write(`event: update\ndata: ${payload}\n\n`);
}

const loop = () => poll().catch((e) => console.error(e.message)).finally(() => setTimeout(loop, POLL_MS));
loop();

// ---- 기사 미리보기: 구글 뉴스 링크 → 원문 주소 → 본문 요약 추출 ----
const articleCache = new Map();
const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  Cookie: 'CONSENT=YES+cb; SOCS=CAI',
};

async function resolveUrl(link) {
  const id = link.split('/articles/')[1].split('?')[0];
  const html = await (await fetch(`https://news.google.com/rss/articles/${id}?oc=5`, { headers: HDR })).text();
  const sg = html.match(/data-n-a-sg="([^"]+)"/), ts = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sg || !ts) throw new Error('resolve failed: no signature (len ' + html.length + ', ' + html.slice(0, 80).replace(/s+/g, ' ') + ')');
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, +ts[1], sg[1]]);
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
  const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { ...HDR, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  const t = await res.text();
  return JSON.parse(JSON.parse(t.split('\n')[2])[0][2])[1];
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko' }, signal: AbortSignal.timeout(10000) });
  const buf = await res.arrayBuffer();
  const head = new TextDecoder('latin1').decode(buf.slice(0, 3000));
  const cs = (res.headers.get('content-type') + head).match(/charset=["']?([\w-]+)/i);
  let charset = cs ? cs[1].toLowerCase() : 'utf-8';
  if (/ks_c_5601|euc-kr/.test(charset)) charset = 'euc-kr';
  try { return new TextDecoder(charset).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

const clean = (h) =>
  decode(h.replace(/<[^>]+>/g, ' ')).replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·')
    .replace(/&[lr]squo;/g, "'").replace(/&[lr]dquo;/g, '"').replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, ' ').trim();

function extract(html) {
  const meta = (n) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${n}["']`, 'i'));
    return m ? clean(m[1]) : '';
  };
  const body = html.replace(/<(script|style|nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '');
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => clean(m[1])).filter((t) => t.length > 40 && !/Internet Explorer|저작권|무단\s?전재/.test(t));
  let text = paras.join('\n\n');
  if (text.length < 150) text = meta('og:description') || meta('description');
  return { text: text.slice(0, 1200) + (text.length > 1200 ? '…' : ''), image: meta('og:image') };
}

async function getArticle(link) {
  if (articleCache.has(link)) return articleCache.get(link);
  const art = known.get(link) || {};
  const url = art.direct ? link : await resolveUrl(link);
  let out = { url, text: art.snippet || '', image: art.image || '' };
  try {
    const ex = extract(await fetchHtml(url));
    out = { url, text: ex.text.length > (art.snippet || '').length ? ex.text : out.text, image: ex.image || out.image };
  } catch (e) { console.warn('본문 실패:', url, e.message); }
  articleCache.set(link, out);
  return out;
}

const INDEX = path.join(__dirname, 'index.html');

http.createServer((req, res) => {
  if (req.url.startsWith('/api/news')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ articles, lastUpdated }));
  }
  if (req.url.startsWith('/api/article')) {
    const link = new URL(req.url, 'http://x').searchParams.get('link') || '';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!known.has(link)) return res.end('{}');
    return getArticle(link).then((a) => res.end(JSON.stringify(a))).catch((e) => { console.warn('원문 주소 실패:', e.message); res.end(JSON.stringify({ error: e.message })); });
  }
  if (req.url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(INDEX).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
