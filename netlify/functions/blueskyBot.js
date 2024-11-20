const { BskyAgent } = require("@atproto/api");
const Parser = require("rss-parser");
const axios = require("axios");

require("dotenv").config();

const parser = new Parser();
const MAX_SIZE_IN_BYTES = 976.56 * 1024;

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

async function resizeImageUntilAcceptable(imageBuffer, contentType) {
  let resizedBuffer = imageBuffer;
  let width = 2048; // Starting width
  let quality = 90; // Starting quality
  const format = contentType.includes("png") ? "png" : "jpeg";

  while (true) {
    resizedBuffer = await sharp(imageBuffer)
      .resize({ width })
      .toFormat(format, { quality })
      .toBuffer();

    // Check if the size is acceptable (below the maximum allowed size)
    if (
      resizedBuffer.length <= MAX_SIZE_IN_BYTES ||
      width <= 500 ||
      quality <= 50
    ) {
      break;
    }

    // Reduce width and quality for the next iteration
    width -= 200;
    quality -= 10;
  }

  return resizedBuffer;
}

async function uploadImgToBsky(imageBuffer, contentType) {
  try {
    // Attempt to upload the image
    const { data } = await agent.uploadBlob(imageBuffer, {
      encoding: contentType,
    });

    return data;
  } catch (error) {
    if (error.status === 400 && error.error === "BlobTooLarge") {
      console.error("Image is too large:", error.message);

      // Resize the image until acceptable
      const resizedImageBuffer = await resizeImageUntilAcceptable(
        imageBuffer,
        contentType
      );

      // Retry uploading the resized image
      try {
        const { data } = await agent.uploadBlob(resizedImageBuffer, {
          encoding: contentType,
        });

        return data;
      } catch (retryError) {
        console.error(`Error uploading resized image: ${retryError.message}`);
        throw retryError;
      }
    } else {
      console.error(`Error uploading image: ${error.message}`);
      throw error;
    }
  }
}

// async function getImageBlob(imageUrl) {
//   try {
//     const response = await fetch(imageUrl);

//     if (!response.ok) {
//       throw new Error(`HTTP error! Status: ${response.status}`);
//     }

//     const contentType = response.headers.get("content-type");
//     const arrayBuffer = await response.arrayBuffer();
//     const imageBuffer = Buffer.from(arrayBuffer);

//     return { imageBuffer, contentType };
//   } catch (error) {
//     console.error("Error fetching image:", error);
//     throw error;
//   }
// }
async function getImageBlob(imageUrl, retries = 3) {
  const controller = new AbortController();
  const timeoutDuration = 10000; // 10 seconds
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutDuration);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Attempt ${attempt}: Fetching image from URL: ${imageUrl}`);

      const response = await fetch(imageUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const contentType = response.headers.get("content-type");
      const arrayBuffer = await response.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuffer);

      return { imageBuffer, contentType };
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        console.error(`Attempt ${attempt}: Fetch request timed out`);
      } else if (error.code === "ETIMEDOUT") {
        console.error(
          `Attempt ${attempt}: Network timeout when fetching image: ${error.message}`
        );
      } else {
        console.error(`Attempt ${attempt}: Error fetching image:`, error);
      }

      if (attempt < retries) {
        console.warn(
          `Attempt ${attempt} failed. Retrying in ${attempt} seconds...`
        );
        await new Promise((res) => setTimeout(res, 1000 * attempt)); // Exponential backoff
        continue;
      } else {
        console.error("Max retries reached. Unable to fetch image.");
        throw error;
      }
    }
  }
}

async function getLatestArticles(feed) {
  const now = Date.now();
  const timespan = process.env.INTERVAL * 60 * 1000;
  const cutoffTime = new Date(now - timespan).getTime();

  const articles = [];

  // Process feed items
  for (let i = feed.items.length - 1; i >= 0; i--) {
    // Reverse order to post oldest first

    const item = feed.items[i];
    const link = item.link;
    const title = item.title;
    const summary = item.summary ? item.summary : title;
    const pubDate = new Date(item.pubDate).getTime();

    console.log(pubDate > cutoffTime, title);

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
