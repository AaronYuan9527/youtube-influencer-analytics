/**
 * VGV KOL Radar Engine — Cloudflare Worker (YouTube TOP100 Decision Pool)
 *
 * ✅ 目標：
 * - 以「觀眾地區(regionCode) × 內容語言(relevanceLanguage) × 行銷品類（語意規則）」生成 TOP100 決策池
 * - API Key 不暴露在前端：存於 Worker 環境變數 YT_API_KEY
 * - 內建快取（Cache API）+ 限流（簡易）避免 quota 爆炸
 *
 * 端點：
 * - GET /ping
 * - GET /top100?region=HK&lang=zh-Hant&cat=food&days=30&excludeTopic=1&strictLang=1&strictCat=1&cache=1
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS
    if (request.method === "OPTIONS") return cors(new Response("", { status: 204 }));

    try {
      if (pathname === "/ping") {
        return cors(json({ ok: true, ts: new Date().toISOString(), worker: "vgv-kol-radar" }));
      }

      if (pathname === "/top100") {
        const qp = url.searchParams;

        const region = (qp.get("region") || "TW").toUpperCase();
        const lang = (qp.get("lang") || "zh-Hant");
        const cat = (qp.get("cat") || "3c");
        const days = clampInt(qp.get("days") || "30", 7, 365);
        const excludeTopic = qp.get("excludeTopic") === "1";
        const strictLang = qp.get("strictLang") !== "0"; // default true
        const strictCat  = qp.get("strictCat") !== "0";  // default true
        const useCache   = qp.get("cache") !== "0";      // default true

        if (!env.YT_API_KEY) {
          return cors(json({ error: "YT_API_KEY not configured in Worker environment." }, 500));
        }

        const cacheKey = `${pathname}|r=${region}|l=${lang}|c=${cat}|d=${days}|xT=${excludeTopic?1:0}|sL=${strictLang?1:0}|sC=${strictCat?1:0}`;
        if (useCache) {
          const cached = await caches.default.match(new Request(url.origin + "/__cache__?" + encodeURIComponent(cacheKey)));
          if (cached) return cors(cached);
        }

        // 主流程
        const t0 = Date.now();
        const result = await buildTop100({
          apiKey: env.YT_API_KEY,
          region, lang, cat, days,
          excludeTopic, strictLang, strictCat
        });

        const resp = cors(json(result, 200));
        // 快取 15 分鐘（可視需求調整）
        if (useCache) {
          const cacheReq = new Request(url.origin + "/__cache__?" + encodeURIComponent(cacheKey));
          resp.headers.set("Cache-Control", "public, max-age=900");
          ctx.waitUntil(caches.default.put(cacheReq, resp.clone()));
        }

        // 附上耗時
        result.meta = result.meta || {};
        result.meta.elapsedMs = Date.now() - t0;

        return cors(json(result, 200));
      }

      return cors(json({ error: "Not found" }, 404));
    } catch (e) {
      return cors(json({ error: e && e.message ? e.message : String(e) }, 500));
    }
  }
};

// ---------- 核心：生成 TOP100 ----------
async function buildTop100({ apiKey, region, lang, cat, days, excludeTopic, strictLang, strictCat }) {
  // 1) 建立候選頻道池：多 query、多頁（search.list type=channel）
  //    注意：search.list 每次成本較高（100 units），所以我們用「少量 query + 少頁」擴池後再精算
  const seeds = CATEGORY_SEEDS[cat] || CATEGORY_SEEDS["3c"];
  const queries = seeds.queries.slice(0, 6); // 控制成本
  const pagesPerQuery = 2; // 控制成本（2頁=100 channels max）
  const maxCandidates = 380; // 再去重後通常 < 300

  const candidateIds = new Set();
  for (const q of queries) {
    let pageToken = "";
    for (let p = 0; p < pagesPerQuery; p++) {
      const s = await ytSearchChannels({ apiKey, q, region, lang, pageToken, maxResults: 50 });
      (s.items || []).forEach(it => { if (it.channelId) candidateIds.add(it.channelId); });
      pageToken = s.nextPageToken || "";
      if (!pageToken) break;
      if (candidateIds.size >= maxCandidates) break;
    }
    if (candidateIds.size >= maxCandidates) break;
  }

  const candidates = Array.from(candidateIds);
  // 2) 拉頻道基礎資料（含 uploads playlist）— 分批 50
  const channelsMap = await getChannels({ apiKey, ids: candidates });

  // 3) 基礎清洗：排除 Topic / 官方音樂噪音、語言/地區偏差（語言嚴格在 video 層處理）
  const filteredChannels = [];
  for (const id of candidates) {
    const ch = channelsMap[id];
    if (!ch) continue;

    if (excludeTopic && looksLikeNoiseChannel(ch)) continue;

    // 小技巧：若頻道描述/關鍵字極度不符合該語言，先擋一層（非硬擋）
    if (strictLang && isObviouslyOtherLanguage(ch, lang)) continue;

    filteredChannels.push(ch);
  }

  // 4) 對每個頻道拉近 20 支 uploads 影片（playlistItems.list）
  //    再 videos.list 批次拉統計（1 unit）計算分數
  const now = Date.now();
  const sinceTs = now - days * 24 * 3600 * 1000;

  // 限制精算頻道數，避免爆量：先用 subs/viewCount 粗排取前 220 再精算出 TOP100
  const rough = filteredChannels
    .sort((a,b)=> (b.subscriberCount||0) - (a.subscriberCount||0))
    .slice(0, 220);

  const scored = [];
  const debugCounters = { checked: 0, droppedByCat: 0, droppedByLang: 0, noVideos: 0 };

  // 並行控制
  const CONCURRENCY = 8;
  const queue = rough.slice();
  const workers = Array.from({ length: CONCURRENCY }, () => (async () => {
    while (queue.length) {
      const ch = queue.shift();
      if (!ch) break;

      debugCounters.checked++;

      const uploads = ch.uploadsPlaylistId;
      if (!uploads) continue;

      // 4-1 取 uploads playlistItems（最多 20）
      const pi = await ytPlaylistItems({ apiKey, playlistId: uploads, maxResults: 20 });
      const videos = (pi.items || [])
        .map(x => ({
          videoId: x.videoId,
          title: x.title,
          description: x.description,
          publishedAt: x.publishedAt
        }))
        .filter(v => v.videoId && v.publishedAt);

      if (videos.length === 0) { debugCounters.noVideos++; continue; }

      // 4-2 期間過濾（publishedAt）
      const within = videos.filter(v => Date.parse(v.publishedAt) >= sinceTs);
      const pick = within.length ? within : videos; // 若期間內不足，至少用最近影片估算

      // 4-3 語言嚴格（用標題/描述簡易偵測 + defaultLanguage 的可用性不穩）
      if (strictLang) {
        const langOkRatio = languageMatchRatio(pick, lang);
        if (langOkRatio < 0.55) { debugCounters.droppedByLang++; continue; }
      }

      // 4-4 行銷品類嚴格（語意關鍵字）
      const catMatch = categoryMatchRatio(pick, cat);
      if (strictCat && catMatch < (CATEGORY_SEEDS[cat]?.minMatchRatio ?? 0.25)) {
        debugCounters.droppedByCat++; continue;
      }

      // 4-5 拉影片 statistics（批次 50）
      const stats = await getVideoStats({ apiKey, ids: pick.map(v => v.videoId) });
      const enriched = pick.map(v => ({...v, ...(stats[v.videoId] || {}) }))
        .filter(v => v.viewCount != null);

      if (enriched.length < 6) { debugCounters.noVideos++; continue; }

      // 5) 計算指標與 Decision Score
      const metrics = computeMetrics(enriched, days);

      const score = decisionScore(metrics);

      scored.push({
        channelId: ch.id,
        title: ch.title,
        customUrl: ch.customUrl || "",
        thumbnail: ch.thumbnail || "",
        subscriberCount: ch.subscriberCount || 0,

        avgViews: metrics.avgViews,
        engagementRate: metrics.engagementRate,
        growthMomentum: metrics.growthMomentum,
        stabilityScore: metrics.stabilityScore,
        commentsPerKViews: metrics.commentsPerKViews,
        categoryMatch: catMatch,

        score
      });
    }
  })());

  await Promise.all(workers);

  // 6) 排序取 TOP100
  scored.sort((a,b)=> b.score - a.score);
  const top = scored.slice(0, 100);

  // 7) Meta
  return {
    generatedAt: new Date().toISOString(),
    meta: {
      region, lang, cat, days,
      excludeTopic, strictLang, strictCat,
      candidateChannels: candidates.length,
      afterChannelFilter: filteredChannels.length,
      roughScored: rough.length,
      scoredCount: scored.length,
      debugCounters
    },
    items: top
  };
}

// ---------- Decision Score ----------
function decisionScore(m) {
  // VGV Decision Score (0~100)
  // 觸及 0.35、互動 0.30、成長 0.20、穩定 0.10、留言 0.05
  const reach = clamp01(m.avgViews / 200000);                    // 以 20萬平均觀看為滿分
  const eng   = clamp01(m.engagementRate / 0.06);                // 6% 互動率為滿分（Like+Comment / View）
  const grow  = clamp01((m.growthMomentum + 0.05) / 0.25);       // 目標：近況比過往 +20% 左右
  const stab  = clamp01(m.stabilityScore);                       // 已是 0~1（越穩越高）
  const cpk   = clamp01(m.commentsPerKViews / 6);                // 每千次觀看 6 則留言視為高

  const score = (reach*0.35 + eng*0.30 + grow*0.20 + stab*0.10 + cpk*0.05) * 100;
  return round1(score);
}

function computeMetrics(videos, days) {
  // videos: [{viewCount, likeCount, commentCount, publishedAt, title, description}]
  const views = videos.map(v => Number(v.viewCount || 0));
  const likes = videos.map(v => Number(v.likeCount || 0));
  const comms = videos.map(v => Number(v.commentCount || 0));

  const avgViews = mean(views);
  const avgLikes = mean(likes);
  const avgComms = mean(comms);

  const engagementRate = avgViews > 0 ? (avgLikes + avgComms) / avgViews : 0;
  const commentsPerKViews = avgViews > 0 ? (avgComms / avgViews) * 1000 : 0;

  // 成長動能：最近 1/2 影片平均觀看 vs 較早 1/2
  const mid = Math.floor(videos.length / 2);
  const recentViews = mean(views.slice(0, mid || 1));
  const olderViews  = mean(views.slice(mid || 1));
  const growthMomentum = olderViews > 0 ? (recentViews - olderViews) / olderViews : 0;

  // 穩定度：CV（變異係數）越低越穩；映射到 0~1
  const cv = coeffVar(views);
  const stabilityScore = clamp01(1 - (cv / 1.2)); // cv=0 =>1, cv=1.2 =>0

  return {
    avgViews: round0(avgViews),
    engagementRate,
    growthMomentum,
    stabilityScore,
    commentsPerKViews: round1(commentsPerKViews)
  };
}

// ---------- 行銷品類 & 語言 ----------
function categoryMatchRatio(videos, cat) {
  const seeds = CATEGORY_SEEDS[cat] || CATEGORY_SEEDS["3c"];
  const kws = seeds.keywords;
  let hit = 0;
  for (const v of videos) {
    const text = ((v.title||"") + " " + (v.description||"")).toLowerCase();
    if (kws.some(k => text.includes(k))) hit++;
  }
  return hit / Math.max(1, videos.length);
}

function languageMatchRatio(videos, lang) {
  // 輕量偵測：繁中/簡中用字、日文假名、韓文字母、英文比例
  let ok = 0;
  for (const v of videos) {
    const t = ((v.title||"") + " " + (v.description||"")).slice(0, 400);
    if (langHeuristicOk(t, lang)) ok++;
  }
  return ok / Math.max(1, videos.length);
}

function langHeuristicOk(text, lang) {
  const s = text || "";
  if (!s.trim()) return false;

  if (lang === "ja")  return /[ぁ-んァ-ン]/.test(s);
  if (lang === "ko")  return /[가-힣]/.test(s);
  if (lang === "en")  return /[A-Za-z]/.test(s) && !/[ぁ-んァ-ン가-힣]/.test(s);
  if (lang === "zh-Hans") {
    // 粗略：出现“这/国/里/为/们”等常见简体用字
    return /[这国里为们]/.test(s) || /[\u4e00-\u9fff]/.test(s);
  }
  // zh-Hant
  return /[這國裡為們]/.test(s) || /[\u4e00-\u9fff]/.test(s);
}

function isObviouslyOtherLanguage(ch, lang) {
  // 若 channel title/desc 完全不含該語系字符，先排除（保守）
  const t = ((ch.title||"") + " " + (ch.description||"")).slice(0, 500);
  if (!t.trim()) return false;
  if (lang === "en") return /[ぁ-んァ-ン가-힣]/.test(t); // 有日/韓就可疑
  if (lang === "ja") return /[가-힣]/.test(t);
  if (lang === "ko") return /[ぁ-んァ-ン]/.test(t);
  // 中文：只要有大量拉丁字母、且几乎没有汉字，视为不吻合
  if (lang.startsWith("zh")) {
    const han = (t.match(/[\u4e00-\u9fff]/g)||[]).length;
    const lat = (t.match(/[A-Za-z]/g)||[]).length;
    return han < 4 && lat > 40;
  }
  return false;
}

// ---------- 噪音頻道判斷 ----------
function looksLikeNoiseChannel(ch) {
  const name = (ch.title || "").toLowerCase();
  const desc = (ch.description || "").toLowerCase();
  const cu   = (ch.customUrl || "").toLowerCase();

  // Topic/Records/Official/VEVO 常是音樂或官方聚合
  const bad = [" - topic", "topic", "vevo", "records", "official", "label", "provided to youtube"];
  if (bad.some(k => name.includes(k) || desc.includes(k) || cu.includes(k))) return true;

  // 極端：描述太短 + 無自訂網址 + 高訂閱但極少影片（常見於聚合/搬運）
  if ((ch.videoCount || 0) < 6 && (ch.subscriberCount || 0) > 200000 && !ch.customUrl) return true;

  return false;
}

// ---------- YouTube API wrappers ----------
async function ytSearchChannels({ apiKey, q, region, lang, pageToken, maxResults }) {
  const u = new URL("https://www.googleapis.com/youtube/v3/search");
  u.searchParams.set("part", "snippet");
  u.searchParams.set("type", "channel");
  u.searchParams.set("maxResults", String(maxResults || 50));
  u.searchParams.set("q", q);
  u.searchParams.set("regionCode", region);
  u.searchParams.set("relevanceLanguage", lang);
  u.searchParams.set("key", apiKey);
  if (pageToken) u.searchParams.set("pageToken", pageToken);

  const r = await fetch(u.toString());
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "search.list failed");

  return {
    nextPageToken: j.nextPageToken || "",
    items: (j.items || []).map(it => ({
      channelId: it?.id?.channelId || ""
    }))
  };
}

async function getChannels({ apiKey, ids }) {
  const map = {};
  const chunks = chunk(ids, 50);
  for (const c of chunks) {
    const u = new URL("https://www.googleapis.com/youtube/v3/channels");
    u.searchParams.set("part", "snippet,statistics,contentDetails,brandingSettings");
    u.searchParams.set("id", c.join(","));
    u.searchParams.set("key", apiKey);

    const r = await fetch(u.toString());
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || "channels.list failed");

    for (const it of (j.items || [])) {
      map[it.id] = normalizeChannel(it);
    }
  }
  return map;
}

function normalizeChannel(it) {
  const sn = it.snippet || {};
  const st = it.statistics || {};
  const cd = it.contentDetails || {};
  const bs = it.brandingSettings || {};
  const uploads = cd?.relatedPlaylists?.uploads || "";

  return {
    id: it.id,
    title: sn.title || "",
    description: sn.description || "",
    customUrl: sn.customUrl ? (sn.customUrl.startsWith("@") ? sn.customUrl : "@"+sn.customUrl) : "",
    thumbnail: sn?.thumbnails?.default?.url || sn?.thumbnails?.medium?.url || "",
    country: sn.country || "",
    uploadsPlaylistId: uploads,
    subscriberCount: toInt(st.subscriberCount),
    viewCount: toInt(st.viewCount),
    videoCount: toInt(st.videoCount),
    keywords: (bs?.channel?.keywords || "")
  };
}

async function ytPlaylistItems({ apiKey, playlistId, maxResults }) {
  // playlistItems.list 1 unit
  const u = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  u.searchParams.set("part", "snippet,contentDetails");
  u.searchParams.set("playlistId", playlistId);
  u.searchParams.set("maxResults", String(maxResults || 20));
  u.searchParams.set("key", apiKey);

  const r = await fetch(u.toString());
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "playlistItems.list failed");

  return {
    items: (j.items || []).map(it => ({
      videoId: it?.contentDetails?.videoId || "",
      title: it?.snippet?.title || "",
      description: it?.snippet?.description || "",
      publishedAt: it?.contentDetails?.videoPublishedAt || it?.snippet?.publishedAt || ""
    }))
  };
}

async function getVideoStats({ apiKey, ids }) {
  const map = {};
  const chunks = chunk(ids.filter(Boolean), 50);
  for (const c of chunks) {
    const u = new URL("https://www.googleapis.com/youtube/v3/videos");
    u.searchParams.set("part", "statistics,snippet");
    u.searchParams.set("id", c.join(","));
    u.searchParams.set("key", apiKey);

    const r = await fetch(u.toString());
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || "videos.list failed");

    for (const it of (j.items || [])) {
      const st = it.statistics || {};
      map[it.id] = {
        viewCount: toInt(st.viewCount),
        likeCount: toInt(st.likeCount),
        commentCount: toInt(st.commentCount),
        defaultLanguage: it?.snippet?.defaultLanguage || "",
        defaultAudioLanguage: it?.snippet?.defaultAudioLanguage || ""
      };
    }
  }
  return map;
}

// ---------- Seeds ----------
const CATEGORY_SEEDS = {
  "3c": {
    minMatchRatio: 0.22,
    queries: [
      "iphone 開箱", "android 開箱", "手機 評測", "筆電 評測",
      "相機 開箱", "耳機 評測", "pc 組裝", "科技 新聞", "3c 開箱"
    ],
    keywords: [
      "iphone","android","手機","开箱","開箱","評測","评测","benchmark","pc","電腦","电脑","筆電","笔电",
      "相機","相机","耳機","耳机","gpu","cpu","顯卡","显卡","macbook","ios","windows","review","unbox"
    ]
  },
  "lifestyle": {
    minMatchRatio: 0.25,
    queries: [
      "vlog 日常", "生活 vlog", "穿搭 lookbook", "room tour",
      "morning routine", "生活風格", "質感 生活", "生活分享"
    ],
    keywords: [
      "vlog","日常","生活","穿搭","lookbook","room tour","morning routine","routine",
      "收納","收拾","整理","居家","家居","质感","hauls","haul","outfit"
    ]
  },
  "food": {
    minMatchRatio: 0.26,
    queries: [
      "美食 探店", "料理 食譜", "家常菜", "烘焙 食譜",
      "餐廳 推薦", "吃播", "food vlog", "recipe"
    ],
    keywords: [
      "美食","料理","食譜","食谱","烘焙","烤箱","煮","做菜","吃","探店","餐廳","餐厅","食堂",
      "recipe","cook","cooking","food","吃播","試吃","开箱吃"
    ]
  },
  "parenting": {
    minMatchRatio: 0.22,
    queries: [
      "育兒 分享", "親子 vlog", "寶寶 日常", "孕期 日記",
      "媽媽 分享", "baby vlog", "mom vlog", "親子 教育"
    ],
    keywords: [
      "育兒","育儿","親子","亲子","寶寶","宝宝","孕","懷孕","怀孕","媽媽","妈妈","baby","mom","family",
      "幼兒","幼儿","小孩","孩子","奶粉","尿布","托嬰","托婴"
    ]
  },
  "finance": {
    minMatchRatio: 0.20,
    queries: [
      "股票 分析", "ETF 解析", "理財 教學", "投資 心法",
      "crypto 教學", "比特幣 分析", "房地產 分析"
    ],
    keywords: [
      "投資","投资","理財","理财","股票","etf","基金","股市","財經","财经","比特幣","比特币","bitcoin",
      "crypto","加密","期貨","期货","美股","台股","港股","房地產","房地产"
    ]
  },
  "travel": {
    minMatchRatio: 0.22,
    queries: [
      "旅遊 vlog", "旅行 攻略", "飯店 開箱", "日本 旅遊",
      "香港 旅遊", "出國 旅行", "travel vlog", "trip"
    ],
    keywords: [
      "旅遊","旅游","旅行","攻略","行程","景點","景点","飯店","酒店","hotel","airbnb","travel","trip",
      "機票","机票","出國","出国","登機","登机","日本","韓國","韩国"
    ]
  },
  "fitness": {
    minMatchRatio: 0.22,
    queries: [
      "健身 訓練", "減脂 訓練", "增肌 訓練", "workout",
      "gym 訓練", "居家 運動", "瑜珈 教學"
    ],
    keywords: [
      "健身","workout","gym","训练","訓練","減脂","减脂","增肌","肌肉","蛋白","热量","卡路里",
      "瑜珈","瑜伽","跑步","重訓","重量訓練","力量","bodybuilding","hiit"
    ]
  }
};

// ---------- Utils ----------
function json(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function cors(resp){
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return resp;
}

function chunk(arr, size){
  const out = [];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}

function toInt(x){
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function mean(arr){
  if(!arr.length) return 0;
  let s=0; for(const x of arr) s += Number(x||0);
  return s / arr.length;
}

function coeffVar(arr){
  if(arr.length < 2) return 0;
  const m = mean(arr);
  if(m <= 0) return 0;
  let v=0; for(const x of arr){ const d = Number(x||0)-m; v += d*d; }
  v /= (arr.length - 1);
  const sd = Math.sqrt(v);
  return sd / m;
}

function clamp01(x){ return Math.max(0, Math.min(1, Number(x||0))); }
function clampInt(x, lo, hi){
  const n = parseInt(x,10);
  if(!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function round1(x){ return Math.round(Number(x||0)*10)/10; }
function round0(x){ return Math.round(Number(x||0)); }
