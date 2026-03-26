#!/usr/bin/env node
/**
 * 马来西亚 4D 开奖结果抓取脚本
 * 数据来源：Magnum API / Damacai API / Sports Toto HTML
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '..', 'data', 'results.json');
const MAX_DRAWS = 10;

// ─── HTTP 工具 ───────────────────────────────────────────────────────────────

function get(url, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,*/*;q=0.9',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
      }
    };
    const req = lib.get(url, opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return get(next, maxRedirects - 1).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error', reject);
  });
}

// ─── 日期工具 ────────────────────────────────────────────────────────────────

function toYMD(d)  { return d.toISOString().split('T')[0]; }        // YYYY-MM-DD
function toDMY(d)  {                                                   // DD/MM/YYYY
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}
function fmt4d(n) { return String(n || '').replace(/\D/g, '').padStart(4, '0').slice(-4); }

// 获取最近 N 个开奖日期 (周三/六/日)
function recentDrawDates(n = 5) {
  const DRAW_DAYS = new Set([0, 3, 6]); // Sun=0, Wed=3, Sat=6
  const dates = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (dates.length < n) {
    if (DRAW_DAYS.has(d.getDay())) dates.push(new Date(d));
    d.setDate(d.getDate() - 1);
  }
  return dates;
}

function dateDisplay(ymd) {
  const [y, m, day] = ymd.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  return `${y}年${m}月${day}日 (${days[d.getDay()]})`;
}

// ─── MAGNUM ──────────────────────────────────────────────────────────────────

async function fetchMagnum(date) {
  const ymd = toYMD(date);
  const url = `https://www.magnum4d.my/results/past/between-dates/null/${ymd}/5`;
  try {
    const res = await get(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const raw = JSON.parse(res.data);
    const arr = Array.isArray(raw) ? raw : (raw.results || raw.data || raw.draws || []);
    if (!arr.length) throw new Error('Empty array');
    return arr.map(d => ({
      date:        (d.drawDate || d.date || ymd).replace(/\//g, '-'),
      drawNo:      d.drawNumber || d.drawNo || d.number || '',
      first:       fmt4d(d.firstPrize  || d.first  || d.prize1 || d.p1 || ''),
      second:      fmt4d(d.secondPrize || d.second || d.prize2 || d.p2 || ''),
      third:       fmt4d(d.thirdPrize  || d.third  || d.prize3 || d.p3 || ''),
      special:     (d.specialPrizes    || d.special    || d.starterList     || []).map(fmt4d),
      consolation: (d.consolationPrizes|| d.consolation|| d.consolidateList || []).map(fmt4d),
    }));
  } catch (e) {
    console.warn(`[Magnum] ${e.message}`);
    return null;
  }
}

// ─── DAMACAI ─────────────────────────────────────────────────────────────────

async function fetchDamacai(date) {
  const dmy = toDMY(date);
  const url = `https://www.damacai.com.my/callpassresult?pastdate=${encodeURIComponent(dmy)}`;
  try {
    const res = await get(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const d = JSON.parse(res.data);
    if (!d || (!d.p1 && !d.firstPrize)) throw new Error('No prize data');
    const [dd, mm, yyyy] = dmy.split('/');
    return [{
      date:        `${yyyy}-${mm}-${dd}`,
      drawNo:      d.drawNo || d.drawNumber || '',
      first:       fmt4d(d.p1 || d.firstPrize  || ''),
      second:      fmt4d(d.p2 || d.secondPrize || ''),
      third:       fmt4d(d.p3 || d.thirdPrize  || ''),
      special:     (d.starterList     || d.specialPrizes     || []).map(fmt4d),
      consolation: (d.consolidateList || d.consolationPrizes || []).map(fmt4d),
    }];
  } catch (e) {
    console.warn(`[Damacai] ${e.message}`);
    return null;
  }
}

// ─── SPORTS TOTO ─────────────────────────────────────────────────────────────

async function fetchToto(date) {
  const ymd = toYMD(date);
  // Try JSON API first (newer endpoint)
  const jsonUrl = `https://www.sportstoto.com.my/api/result/latest?date=${ymd}`;
  try {
    const res = await get(jsonUrl);
    if (res.status === 200) {
      const d = JSON.parse(res.data);
      if (d && (d.p1 || d.first || d.firstPrize)) {
        return [{
          date:        ymd,
          drawNo:      d.drawNo || d.drawNumber || '',
          first:       fmt4d(d.p1 || d.first || d.firstPrize  || ''),
          second:      fmt4d(d.p2 || d.second|| d.secondPrize || ''),
          third:       fmt4d(d.p3 || d.third || d.thirdPrize  || ''),
          special:     (d.starterList  || d.special     || []).map(fmt4d),
          consolation: (d.consolation  || d.consolidate || []).map(fmt4d),
        }];
      }
    }
  } catch (_) {}

  // Fallback: parse Toto HTML results page
  try {
    const res = await get(`http://www.sportstoto.com.my/result-history.aspx`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const html = res.data;

    // Extract 4D section and prize numbers
    const drawNoM = html.match(/4D[^<]*?(\d{4,5}\/\d{2,4})/i);
    const nums = [];
    // Match all 4-digit numbers in result cells
    const cellRe = /(?:class="[^"]*result[^"]*"|<td[^>]*>)\s*(\d{4})\s*</gi;
    let m;
    while ((m = cellRe.exec(html)) !== null) nums.push(m[1]);

    if (nums.length < 3) throw new Error('Cannot parse Toto HTML');
    return [{
      date:        ymd,
      drawNo:      drawNoM ? drawNoM[1] : '',
      first:       nums[0] || '',
      second:      nums[1] || '',
      third:       nums[2] || '',
      special:     nums.slice(3, 13),
      consolation: nums.slice(13, 23),
    }];
  } catch (e) {
    console.warn(`[Toto] ${e.message}`);
    return null;
  }
}

// ─── 聚合抓取 (26myr.com 全家桶) ─────────────────────────────────────────────

async function fetchAll26myr(date) {
  const ymd = toYMD(date);
  try {
    const res = await get(`https://26myr.com/4d/result/${ymd}`);
    const html = res.data || '';
    if (res.status !== 200 || !html.includes('Magnum')) throw new Error(`HTTP ${res.status}`);

    // Generic prize extractor: find operator section then grab numbers
    function extractOp(name, aliases) {
      const re = new RegExp(`(?:${aliases.join('|')})[\\s\\S]{0,500}?` +
        `(\\d{4})[\\s\\S]{0,200}?(\\d{4})[\\s\\S]{0,200}?(\\d{4})`, 'i');
      const m = html.match(re);
      if (!m) return null;
      return { first: m[1], second: m[2], third: m[3], special: [], consolation: [] };
    }

    const magnum  = extractOp('Magnum',  ['Magnum', 'magnum', '万能']);
    const damacai = extractOp('Damacai', ['Damacai', 'Da Ma Cai', 'damacai', '大马彩']);
    const toto    = extractOp('Toto',    ['Sports Toto', 'Toto', 'toto', '体育彩票']);

    return { date: ymd, magnum, damacai, toto };
  } catch (e) {
    console.warn(`[26myr] ${e.message}`);
    return null;
  }
}

// ─── 主逻辑 ──────────────────────────────────────────────────────────────────

async function main() {
  const dates = recentDrawDates(MAX_DRAWS);
  console.log(`抓取最近 ${dates.length} 个开奖日期...`);

  // Load existing results to merge
  let existing = { lastUpdated: '', draws: [] };
  try { existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch (_) {}
  const existingByDate = Object.fromEntries(existing.draws.map(d => [d.date, d]));

  const newDraws = [];

  for (const date of dates) {
    const ymd = toYMD(date);
    console.log(`\n[${ymd}] 抓取中...`);

    // Fetch each operator
    const [magnumData, damacaiData, totoData, fallback] = await Promise.all([
      fetchMagnum(date),
      fetchDamacai(date),
      fetchToto(date),
      fetchAll26myr(date),
    ]);

    const magnumResult  = (magnumData  && magnumData[0])  || (fallback && fallback.magnum)  || existingByDate[ymd]?.operators?.magnum  || null;
    const damacaiResult = (damacaiData && damacaiData[0]) || (fallback && fallback.damacai) || existingByDate[ymd]?.operators?.damacai || null;
    const totoResult    = (totoData    && totoData[0])    || (fallback && fallback.toto)    || existingByDate[ymd]?.operators?.toto    || null;

    if (!magnumResult && !damacaiResult && !totoResult) {
      console.log(`  ↳ 无数据，跳过`);
      continue;
    }

    const draw = {
      date: ymd,
      dateDisplay: dateDisplay(ymd),
      operators: {
        magnum: magnumResult ? {
          name: '万能 Magnum 4D',
          drawNo: magnumResult.drawNo || '',
          first:  magnumResult.first  || '',
          second: magnumResult.second || '',
          third:  magnumResult.third  || '',
          special:     magnumResult.special     || [],
          consolation: magnumResult.consolation || [],
        } : null,
        damacai: damacaiResult ? {
          name: '大马彩 Da Ma Cai',
          drawNo: damacaiResult.drawNo || '',
          first:  damacaiResult.first  || '',
          second: damacaiResult.second || '',
          third:  damacaiResult.third  || '',
          special:     damacaiResult.special     || [],
          consolation: damacaiResult.consolation || [],
        } : null,
        toto: totoResult ? {
          name: '体育彩票 Sports Toto',
          drawNo: totoResult.drawNo || '',
          first:  totoResult.first  || '',
          second: totoResult.second || '',
          third:  totoResult.third  || '',
          special:     totoResult.special     || [],
          consolation: totoResult.consolation || [],
        } : null,
      }
    };

    if (magnumResult)  console.log(`  ✓ Magnum:  ${draw.operators.magnum.first} / ${draw.operators.magnum.second} / ${draw.operators.magnum.third}`);
    if (damacaiResult) console.log(`  ✓ Damacai: ${draw.operators.damacai.first} / ${draw.operators.damacai.second} / ${draw.operators.damacai.third}`);
    if (totoResult)    console.log(`  ✓ Toto:    ${draw.operators.toto.first} / ${draw.operators.toto.second} / ${draw.operators.toto.third}`);

    newDraws.push(draw);
  }

  // Sort by date descending, keep max MAX_DRAWS
  newDraws.sort((a, b) => b.date.localeCompare(a.date));
  const trimmed = newDraws.slice(0, MAX_DRAWS);

  const output = {
    lastUpdated: new Date().toISOString(),
    draws: trimmed,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ 已保存 ${trimmed.length} 期结果到 ${OUTPUT}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
