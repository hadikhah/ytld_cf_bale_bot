// worker/src/search.ts
// ======================================
//  YOUTUBE & WEB SEARCH – NO API KEYS
// ======================================

const YT_MAX_RESULTS = 10;
const YT_USER_AGENT = "Mozilla/5.0 (compatible; BaleYouTubeBot/1.0)";

// ---------------- Markdown escaping ----------------
function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`");
}

// ---------------- Types ----------------
export interface YtResult {
  title: string;
  videoId: string;
  duration: string;
  published: string;
  thumb: string;
}

export interface YtPage {
  results: YtResult[];
  nextToken: string | null;
}

// ============================================
//  fetchYtPage
// ============================================
export async function fetchYtPage(
  query: string,
  filter: "relevance" | "date",
  continuationToken?: string
): Promise<YtPage> {
  let url: string;

  if (continuationToken) {
    url = `https://www.youtube.com/browse_ajax?ctoken=${encodeURIComponent(continuationToken)}`;
  } else {
    const params = new URLSearchParams({ search_query: query });
    if (filter === "date") {
      params.set("sp", "CAI=");   // encode will turn '=' into %3D
    }
    url = `https://www.youtube.com/results?${params.toString()}`;
  }

  const resp = await fetch(url, {
    headers: { "User-Agent": YT_USER_AGENT },
  });
  const text = await resp.text();

  let data: any;

  if (continuationToken) {
    try {
      data = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{.*\}/s);
      if (!jsonMatch) {
        console.log("YT continuation: no JSON");
        return { results: [], nextToken: null };
      }
      data = JSON.parse(jsonMatch[0]);
    }
  } else {
    const match = text.match(
      /var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s
    );
    if (!match) {
      console.log("YT search: ytInitialData missing");
      return { results: [], nextToken: null };
    }
    data = JSON.parse(match[1]);
  }

  // ----- Extract items + continuation token -----
  let items: any[] = [];
  let nextToken: string | null = null;

  if (continuationToken) {
    const cont = data?.continuationContents?.itemSectionContinuation;
    if (cont) {
      items = cont.contents ?? [];
      nextToken = cont.continuations?.[0]?.nextContinuationData?.continuation ?? null;
    } else {
      items = data?.contents ?? [];
      nextToken = data?.continuations?.[0]?.nextContinuationData?.continuation ?? null;
    }
  } else {
    const primary =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents;
    const sectionList = primary?.sectionListRenderer;

    // 1) Check sectionList-level continuations (this is often where the token sits)
    if (sectionList) {
      nextToken =
        sectionList.continuations?.[0]?.nextContinuationData?.continuation ?? null;
    }

    // 2) Dive into the first itemSection
    const itemSection = sectionList?.contents?.[0]?.itemSectionRenderer;
    if (itemSection) {
      const itsItems = itemSection.contents ?? [];
      items = itsItems;

      // 3) Check itemSection-level continuations (sometimes duplicative, but safe)
      const localToken =
        itemSection.continuations?.[0]?.nextContinuationData?.continuation;
      if (localToken) nextToken = localToken;

      // 4) Check last item for a continuationItemRenderer
      if (!nextToken && items.length > 0) {
        const last = items[items.length - 1];
        const ctoken =
          last?.continuationItemRenderer?.continuationEndpoint
            ?.continuationCommand?.token;
        if (ctoken) nextToken = ctoken;
      }
    }

    // DEBUG: log the keys that *could* hold the token
    console.log(
      "YT token debug:",
      "sectionList.continuations:",
      !!sectionList?.continuations,
      "itemSection.continuations:",
      !!itemSection?.continuations,
      "last item type:",
      items.length ? Object.keys(items[items.length - 1])[0] : "none"
    );
  }

  // ----- Build results -----
  const results: YtResult[] = [];
  for (const item of items) {
    const vr = item.videoRenderer;
    if (!vr) continue;
    const videoId = vr.videoId;
    if (!videoId) continue;

    const titleRaw = vr.title?.runs?.[0]?.text || "Untitled";

    let duration = "";
    if (vr.lengthText?.simpleText) {
      duration = vr.lengthText.simpleText;
    } else if (vr.lengthText?.accessibility?.accessibilityData?.label) {
      duration = vr.lengthText.accessibility.accessibilityData.label
        .replace(/^.*?: /, "")
        .trim();
    }

    let published = "";
    if (vr.publishedTimeText?.simpleText) {
      published = vr.publishedTimeText.simpleText;
    }

    let thumb = "";
    const thumbs = vr.thumbnail?.thumbnails;
    if (thumbs && thumbs.length > 0) {
      thumb = thumbs[thumbs.length - 1].url;
    } else {
      thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }

    results.push({ title: titleRaw, videoId, duration, published, thumb });
    if (results.length >= YT_MAX_RESULTS) break;
  }

  console.log(
    `YT page (${filter}, cont: ${!!continuationToken}):`,
    results.map((r) => r.title).slice(0, 3),
    "nextToken exists:",
    !!nextToken
  );

  return { results, nextToken };
}

// ============================================
//  buildYtMessage
// ============================================
export function buildYtMessage(page: YtPage): {
  text: string;
  keyboard: any[][];
} {
  let text = "🎬 *YouTube results:*\n\n";
  const keyboard: any[][] = [];

  if (page.results.length === 0) {
    text = "No more video results.";
    return { text, keyboard };
  }

  page.results.forEach((r, i) => {
    const idx = i + 1;
    const title = escapeMarkdown(r.title);
    const details: string[] = [];
    if (r.published) details.push(`📅 ${r.published}`);
    if (r.duration) details.push(`⏱ ${r.duration}`);

    text += `${idx}\\. *${title}*\n`;
    if (details.length) text += `_${details.join(" | ")}_\n`;
    text += "\n";

    keyboard.push([
      {
        text: `▶️ ${idx}. Download`,
        callback_data: `ytdl|${r.videoId}`,
      },
      {
        text: `🖼️ Thumb`,
        callback_data: `thumb|${r.videoId}`,
      },
    ]);
  });

  if (page.nextToken) {
    keyboard.push([
      {
        text: "Next ➡️",
        callback_data: `yt_next|${page.nextToken}`,
      },
    ]);
  }

  return { text, keyboard };
}

export async function searchYouTube(
  query: string,
  filter: "relevance" | "date" = "relevance",
  nextToken?: string
): Promise<YtPage> {
  return fetchYtPage(query, filter, nextToken);
}

// ============================================
//  WEB SEARCH – DuckDuckGo Instant Answer + SearXNG
// ============================================

const SEARX_INSTANCES = [
  "https://search.sapti.me",
  "https://searx.tiekoetter.com",
  "https://searx.be",
  "https://search.bus-hit.me",
  "https://searx.tux.computer",
  "https://searx.fmac.xyz",
];

async function trySearXNG(query: string): Promise<string | null> {
  for (const base of SEARX_INSTANCES) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
      const resp = await fetch(url, {
        headers: { "User-Agent": YT_USER_AGENT },
      });
      if (!resp.ok) {
        console.log(`SearXNG ${base} status ${resp.status}`);
        continue;
      }
      // Some instances may return HTML error pages, so check content-type
      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        console.log(`SearXNG ${base} non-JSON response`);
        continue;
      }
      const json: any = await resp.json();
      const results = json.results ?? [];
      if (results.length > 0) {
        console.log(`SearXNG (${base}) found ${results.length} results`);
        let output = "*Web results:*\n\n";
        let count = 0;
        for (const r of results) {
          if (!r.url || !r.title) continue;
          output += `🌐 [${escapeMarkdown(r.title)}](${r.url})\n\n`;
          count++;
          if (count >= 5) break;
        }
        return output;
      }
    } catch (e) {
      console.log(`SearXNG ${base} error:`, e);
    }
  }
  return null;
}

async function tryDuckDuckGoInstantAnswer(query: string): Promise<string | null> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await fetch(url, { headers: { "User-Agent": YT_USER_AGENT } });
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const related: any[] = json.RelatedTopics ?? [];
    const results: { title: string; url: string }[] = [];
    for (const topic of related) {
      if (topic.FirstURL && topic.Text) {
        // Text may contain HTML; strip it
        const title = topic.Text.replace(/<[^>]+>/g, "").trim();
        results.push({ title, url: topic.FirstURL });
        if (results.length >= 5) break;
      }
    }
    if (results.length > 0) {
      console.log("DDG Instant Answer found", results.length, "related topics");
      let output = "*Web results:*\n\n";
      for (const r of results) {
        output += `🌐 [${escapeMarkdown(r.title)}](${r.url})\n\n`;
      }
      return output;
    }
  } catch (e) {
    console.log("DDG Instant Answer error:", e);
  }
  return null;
}

function parseDuckDuckGoLiteHtml(html: string): { title: string; url: string }[] {
  const results: { title: string; url: string }[] = [];
  // Pattern for lite.duckduckgo.com
  const liteRegex = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  let match;
  while ((match = liteRegex.exec(html)) !== null) {
    let link = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    if (!link.startsWith("http")) link = "https:" + link;
    results.push({ title, url: link });
    if (results.length >= 5) break;
  }
  if (results.length === 0) {
    // Fallback class name (old HTML version)
    const oldRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
    while ((match = oldRegex.exec(html)) !== null) {
      let link = match[1];
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      if (!link.startsWith("http")) link = "https:" + link;
      results.push({ title, url: link });
      if (results.length >= 5) break;
    }
  }
  return results;
}

export async function searchWeb(query: string): Promise<string> {
  // 1) DuckDuckGo Lite
  const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(liteUrl, {
      headers: { "User-Agent": YT_USER_AGENT },
    });
    const html = await resp.text();
    console.log("DDG Lite snippet:", html.slice(0, 200));
    const results = parseDuckDuckGoLiteHtml(html);
    if (results.length > 0) {
      console.log("DDG Lite found", results.length, "results");
      let output = "*Web results:*\n\n";
      results.forEach(r => {
        output += `🌐 [${escapeMarkdown(r.title)}](${r.url})\n\n`;
      });
      return output;
    }
  } catch (e) {
    console.log("DDG Lite error:", e);
  }

  // 2) DuckDuckGo Instant Answer API
  const instantResult = await tryDuckDuckGoInstantAnswer(query);
  if (instantResult) return instantResult;

  // 3) DuckDuckGo HTML (old)
  const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(htmlUrl, {
      headers: { "User-Agent": YT_USER_AGENT },
    });
    const html = await resp.text();
    console.log("DDG HTML snippet:", html.slice(0, 200));
    const results = parseDuckDuckGoLiteHtml(html);
    if (results.length > 0) {
      console.log("DDG HTML found", results.length, "results");
      let output = "*Web results:*\n\n";
      results.forEach(r => {
        output += `🌐 [${escapeMarkdown(r.title)}](${r.url})\n\n`;
      });
      return output;
    }
  } catch (e) {
    console.log("DDG HTML error:", e);
  }

  // 4) SearXNG rotation
  const searxResult = await trySearXNG(query);
  if (searxResult) return searxResult;

  return "No web results found.";
}
