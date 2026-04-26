// worker/src/search.ts

/**
 * Minimal Markdown escape – prevents breaking link syntax
 * and unintended formatting on Bale.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`');
}

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

/**
 * Fetch a YouTube search page (possibly with a continuation token).
 * filter can be "relevance" (default) or "date".
 */
export async function fetchYtPage(
  query: string,
  filter: "relevance" | "date",
  continuationToken?: string
): Promise<YtPage> {
  let url: string;
  if (continuationToken) {
    // Use the browse endpoint for continuation
    url = `https://www.youtube.com/browse_ajax?ctoken=${encodeURIComponent(
      continuationToken
    )}&continuation=${encodeURIComponent(continuationToken)}`;
  } else {
    const params = new URLSearchParams({ search_query: query });
    if (filter === "date") params.set("sp", "CAI%253D"); // sort by upload date
    url = `https://www.youtube.com/results?${params.toString()}`;
  }

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)" },
  });
  const html = await res.text();

  let data: any;
  if (continuationToken) {
    // Response is JSON wrapped in some HTML (the browse_ajax returns JSON).
    // Try to extract JSON from the page.
    const jsonMatch = html.match(/\{.*\}/s);
    if (!jsonMatch) {
      console.log("YT continuation: no JSON found");
      return { results: [], nextToken: null };
    }
    try {
      data = JSON.parse(jsonMatch[0]);
    } catch {
      console.log("YT continuation: JSON parse error");
      return { results: [], nextToken: null };
    }
  } else {
    // Initial search – extract ytInitialData
    const match = html.match(
      /var ytInitialData\s*=\s*({.*?});\s*<\/script>/s
    );
    if (!match) {
      console.log("YT search: could not find ytInitialData");
      return { results: [], nextToken: null };
    }
    try {
      data = JSON.parse(match[1]);
    } catch {
      console.log("YT search: JSON parse error");
      return { results: [], nextToken: null };
    }
  }

  // Navigate to the list of video renderers
  const contents =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
  const allItems = contents ?? [];
  const results: YtResult[] = [];
  let nextToken: string | null = null;

  for (const item of allItems) {
    const vr = item.videoRenderer;
    if (!vr) {
      // Check for continuation token inside the item list
      const cont = item.continuationItemRenderer;
      if (cont?.continuationEndpoint?.continuationCommand?.token) {
        nextToken = cont.continuationEndpoint.continuationCommand.token;
      }
      continue;
    }

    const titleRaw = vr.title?.runs?.[0]?.text || "Untitled";
    const videoId = vr.videoId;
    if (!videoId) continue;

    // Duration: usually lengthText.simpleText
    let duration = "";
    if (vr.lengthText?.simpleText) {
      duration = vr.lengthText.simpleText;
    } else if (vr.lengthText?.accessibility?.accessibilityData?.label) {
      // e.g. "4 minutes, 20 seconds"
      duration = vr.lengthText.accessibility.accessibilityData.label
        .replace(/^.*?: /, "")
        .trim();
    }

    // Published date – often missing; fallback to empty
    let published = "";
    if (vr.publishedTimeText?.simpleText) {
      published = vr.publishedTimeText.simpleText;
    } else if (vr.detailedMetadataSnippets?.[0]?.snippetText?.runs?.[0]?.text) {
      published = vr.detailedMetadataSnippets[0].snippetText.runs[0].text;
    }

    // Thumbnail – get the highest-quality one
    const thumb =
      vr.thumbnail?.thumbnails?.[vr.thumbnail.thumbnails.length - 1]?.url || "";

    results.push({
      title: titleRaw,
      videoId,
      duration,
      published,
      thumb,
    });

    if (results.length >= 5) break; // only 5 per page
  }

  // If there are more results, continuation is often available
  // but we may have missed it; re-check
  if (!nextToken) {
    const lastItem = allItems[allItems.length - 1];
    if (lastItem?.continuationItemRenderer) {
      nextToken =
        lastItem.continuationItemRenderer.continuationEndpoint
          .continuationCommand?.token;
    }
  }

  console.log(
    `YT search page (${filter}, cont: ${!!continuationToken}):`,
    results.map((r) => r.title).slice(0, 3),
    "nextToken exists:",
    !!nextToken
  );

  return { results, nextToken };
}

/**
 * Build Markdown text + inline keyboard for a YouTube results page.
 */
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
    const details = [];
    if (r.published) details.push(`📅 ${r.published}`);
    if (r.duration) details.push(`⏱ ${r.duration}`);
    text += `${idx}\\. *${title}*\n`;
    if (details.length) text += `_${details.join(" | ")}_\n`;
    text += "\n";

    // Two buttons for each video
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

  // "Next page" button if there is a continuation token
  if (page.nextToken) {
    keyboard.push([
      {
        text: "Next ➡️",
        callback_data: `yt_next|${page.nextToken}`,
      },
    ]);
  }

  return { text, keyboard: keyboard };
}

/**
 * Search YouTube (first page)
 */
export async function searchYouTube(
  query: string,
  filter: "relevance" | "date" = "relevance",
  nextToken?: string
): Promise<YtPage> {
  return fetchYtPage(query, filter, nextToken);
}

/**
 * Search the web via DuckDuckGo Lite (no API key).
 * Returns up to 5 results as Markdown text.
 */
export async function searchWeb(query: string): Promise<string> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(
    query
  )}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)" },
  });
  const html = await res.text();

  // Regex for DuckDuckGo Lite results
  const resultRegex =
    /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  let match;
  let count = 0;
  let output = "";
  const results: { title: string; url: string }[] = [];

  while ((match = resultRegex.exec(html)) !== null) {
    let rawLink = match[1];
    const rawTitle = match[2].replace(/<[^>]+>/g, "").trim();

    if (!rawLink.startsWith("http")) {
      rawLink = "https:" + rawLink;
    }

    const title = escapeMarkdown(rawTitle);
    output += `🌐 [${title}](${rawLink})\n\n`;
    results.push({ title: rawTitle, url: rawLink });
    count++;
    if (count >= 5) break;
  }

  console.log("Web search results:", JSON.stringify(results.slice(0, 3)));
  if (!output) return "No web results found.";
  return "*Web results:*\n\n" + output;
}
