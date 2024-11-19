const { BskyAgent } = require("@atproto/api");
const Parser = require("rss-parser");
const axios = require("axios");

require("dotenv").config();

const parser = new Parser();

// Create a Bluesky Agent
const agent = new BskyAgent({
  service: "https://bsky.social",
});

// Get the post image and post description from the article link
async function getArticleDetails(url) {
  try {
    const res = await fetch(url);
    const html = await res.text();

    const match = html.match(/<meta property="og:image" content="([^"]+)"/i);

    return {
      img: match ? match[1] : false, // Extract the URL or return false if not found
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function uploadImgToBsky(imageBuffer, contentType) {
  try {
    // Upload the image to Bluesky
    const { data } = await agent.uploadBlob(imageBuffer, {
      encoding: contentType,
    });

    return data;
  } catch (error) {
    console.error(`Error uploading image from URL: ${error.message}`);
    throw error;
  }
}

async function getImageBlob(imageUrl) {
  try {
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const contentType = response.headers.get("content-type");
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    return { imageBuffer, contentType };
  } catch (error) {
    console.error("Error fetching image:", error);
    throw error;
  }
}

async function getLatestArticles(feed) {
  const now = new Date();
  const cutoffTime = new Date(now.getTime() - process.env.INTERVAL * 60 * 1000);

  const articles = [];

  // Process feed items
  for (let i = feed.items.length - 1; i >= 0; i--) {
    // Reverse order to post oldest first

    const item = feed.items[i];
    const link = item.link;
    const title = item.title;
    const summary = item.summary ? item.summary : title;
    const pubDate = new Date(item.pubDate);

    if (!(pubDate > cutoffTime && pubDate <= now)) continue;

    const details = await getArticleDetails(link);
    const { imageBuffer, contentType } = await getImageBlob(details.img);
    const imageData = await uploadImgToBsky(imageBuffer, contentType);

    let message = {
      $type: "app.bsky.feed.post",
      text: summary,
      createdAt: new Date().toISOString(),
      embed: {
        $type: "app.bsky.embed.external",
        external: {
          uri: link,
          title: title,
          description: summary,
          thumb: imageData.blob,
        },
      },
    };
    articles.push(message);
  }
  return articles;
}

async function postArticle(article) {
  await agent.post(article);
  console.log("Article posted:", article.text);
}

async function main() {
  try {
    await agent.login({
      identifier: process.env.BLUESKY_USERNAME,
      password: process.env.BLUESKY_PASSWORD,
    });

    const feed = await parser.parseURL(process.env.RSS_FEED);

    if (!feed.items.length) {
      console.log("RSS feed empty");
      return;
    }

    const latestArticles = await getLatestArticles(feed);

    if (!latestArticles.length) {
      console.log("No new articles");
      return;
    }

    latestArticles.forEach(async (article) => await postArticle(article));

    return latestArticles;
  } catch (error) {
    console.log("error", error);
  }
}

export default async (req, _) => {
  const publishedArticles = await main();
  return Response.json({ articles: JSON.stringify(publishedArticles) });
};
