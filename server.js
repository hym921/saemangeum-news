// 새만금 현대차그룹 AI 데이터센터 뉴스 모니터 — 의존성 없는 Node 서버
// 실행: node server.js  →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const POLL_MS = 5 * 60 * 1000; // 5분마다 새 기사 수집

// 검색어 (Google 뉴스 + Bing 뉴스에 모두 요청)
const QUERIES = [
  '현대차 새만금',
  '새만금 현대차그룹',
  '새만금 현대차 AI 데이터센터',
  '새만금 AI 데이터센터',
  '새만금 데이터센터',
  '새만금개발청 현대차',
  '새만금개발청 AI 데이터센터',
  '새만금개발청',
  '새만금 현대차 수소',
  '새만금 현대차 로봇',
  '새만금 피지컬 AI',
  '새만금 산업단지 현대자동차',
  '새만금 현대오토에버',
  '새만금 GPU 데이터센터',
  '현대차 새만금 투자 8.9조',
  '새만금 건축심의',
];

// 분류 키워드 (탭): 제목 + 요약에서 검사
const RULES = {
  hyundai: /현대|기아|정의선/,
  agency: /새만금\s?개발청|새만금청|새만금개발공사|새만금위원회/,
  aidc: /데이터\s?센터|AI\s?DC|AIDC|GPU|인공지능|\bAI\b|피지컬/i,
};

function tagsOf(text) {
  return Object.keys(RULES).filter((k) => RULES[k].test(text));
}

// 관련성: 새만금 언급 + 세 분류 중 하나 이상, 또는 현대차 + 데이터센터
function isRelevant(text) {
  const tags = tagsOf(text);
  if (/새만금/.test(text) && tags.length) return true;
  return tags.includes('hyundai') && /데이터\s?센터/.test(text);
}

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : '';
};

async function fetchGoogle(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${res.status} google ${q}`);
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

// Bing 뉴스 RSS: 링크 안에 원문 주소가 그대로 들어 있어 미리보기가 안정적이다
async function fetchBing(q) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setmkt=ko-KR&count=50`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${res.status} bing ${q}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const it = m[1];
    const raw = tag(it, 'link');
    const real = new URL(raw).searchParams.get('url');
    return {
      title: tag(it, 'title'),
      link: real || raw,
      url: real || '',
      source: tag(it, 'News:Source').replace(/ on MSN$/, '') || '출처 미상',
      pubDate: new Date(tag(it, 'pubDate')).toISOString(),
      snippet: tag(it, 'description'),
      image: tag(it, 'News:Image').replace(/^http:/, 'https:'),
    };
  });
}

// 네이버 뉴스 검색(키 불필요): 제목으로 원문 주소·요약을 찾는 용도
async function fetchNaver(q) {
  const url = `https://search.naver.com/search.naver?where=news&sort=1&query=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!res.ok) throw new Error(`${res.status} naver`);
  const html = await res.text();
  const strip = (h) => decode(h.replace(/<[^>]+>/g, '')).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return [...html.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*data-heatmap-target="\.tit"[^>]*>([\s\S]*?)<\/a>(?:\s*<a[^>]*data-heatmap-target="\.body"[^>]*>([\s\S]*?)<\/a>)?/g)]
    .map((m) => ({ url: decode(m[1]), title: strip(m[2]), snippet: m[3] ? strip(m[3]) : '' }));
}

let articles = []; // 최신순
let lastUpdated = null;
const seen = new Set();
const known = new Map(); // link → article (미리보기 요청 검증용)
const clients = new Set();

const keyOf = (a) => a.title.replace(/[\s\W]+/g, '').slice(0, 40);

// 구글 링크 기사는 서버에서 원문 주소를 못 풀 수 있어, 제목으로 Bing·네이버를 검색해 원문 주소를 찾아 붙인다
async function findOriginal(a) {
  try {
    const win = keyOf(a).slice(3, 15); // 앞머리 [태그]·말줄임 차이를 피해 중간 구간으로 비교
    const same = (b) => keyOf(b).includes(win);
    let hit = (await fetchBing(a.title.slice(0, 60))).find(same);
    if (hit) hit = { url: hit.url, snippet: hit.snippet, image: hit.image };
    else hit = (await fetchNaver(a.title.replace(/^\[[^\]]*\]\s*/, '').slice(0, 40))).find(same);
    if (hit && hit.url) Object.assign(a, { url: hit.url, snippet: a.snippet || hit.snippet, image: a.image || hit.image });
  } catch { /* 실패해도 구글 링크로 계속 표시 */ }
}

async function upgradeInBackground(list) {
  const queue = list.filter((a) => !a.url);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) await findOriginal(queue.shift());
  }));
}

async function poll() {
  const jobs = QUERIES.flatMap((q) => [fetchBing(q), fetchGoogle(q)]); // Bing 먼저: 같은 기사면 원문 주소가 있는 쪽이 남는다
  const results = await Promise.allSettled(jobs);
  const fresh = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') { console.warn('수집 실패:', r.reason.message); continue; }
    for (const a of r.value) {
      const text = a.title + ' ' + (a.snippet || '');
      const k = keyOf(a);
      if (!isRelevant(text) || seen.has(k)) continue;
      seen.add(k);
      a.tags = tagsOf(text);
      known.set(a.link, a);
      fresh.push(a);
    }
  }
  lastUpdated = new Date().toISOString();
  if (fresh.length) {
    articles = [...fresh, ...articles].sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    console.log(`[${lastUpdated}] 새 기사 ${fresh.length}건 (총 ${articles.length})`);
  }
  const first = fresh.length && articles.length === fresh.length;
  const payload = JSON.stringify({ fresh: first ? [] : fresh, lastUpdated });
  for (const c of clients) c.write(`event: update\ndata: ${payload}\n\n`);
  upgradeInBackground(fresh); // 화면에 먼저 내보내고, 원문 주소 찾기는 뒤에서 진행
}

const loop = () => poll().catch((e) => console.error(e.message)).finally(() => setTimeout(loop, POLL_MS));
loop();

// ---- 기사 미리보기: 원문 주소 → 본문 요약 추출 ----
const articleCache = new Map();
const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  Cookie: 'CONSENT=YES+cb; SOCS=CAI',
};

async function resolveGoogleUrl(link) {
  const id = link.split('/articles/')[1].split('?')[0];
  const html = await (await fetch(`https://news.google.com/rss/articles/${id}?oc=5`, { headers: HDR })).text();
  const sg = html.match(/data-n-a-sg="([^"]+)"/), ts = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sg || !ts) throw new Error('resolve failed');
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
    .replace(/\s+/g, ' ').trim();

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
  let url = art.url;
  if (!url && link.startsWith('https://news.google.com/')) {
    try { url = await resolveGoogleUrl(link); } catch (e) { console.warn('구글 링크 해석 실패:', e.message); }
  }
  let out = { url: url || link, text: art.snippet || '', image: art.image || '' };
  if (url) {
    try {
      const ex = extract(await fetchHtml(url));
      out = { url, text: ex.text.length > out.text.length ? ex.text : out.text, image: ex.image || out.image };
    } catch (e) { console.warn('본문 실패:', url, e.message); }
  }
  if (out.text) articleCache.set(link, out); // 실패 결과는 캐시하지 않아 다음에 다시 시도
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
    return getArticle(link).then((a) => res.end(JSON.stringify(a))).catch(() => res.end('{}'));
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
